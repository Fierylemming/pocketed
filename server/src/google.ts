// "Sign in with Google" (Option B) — read-only Google Calendar access through
// the Google Calendar API. Unlike the secret iCal address, the API reports
// each event's colour, and it expands repeating events and limits the result
// to the upcoming window itself, so the Worker only relays a small JSON list.
//
// Flow (standard OAuth "web server" flow, refresh token kept in D1):
//   app  -> POST /v1/google/start {returnUrl}  -> { url } (Google's consent page)
//   user -> Google -> GET /v1/google/callback?code&state (public, one-time state)
//   Worker swaps the code for tokens, then redirects back to the app with
//   #google=connected (or #google=error&message=…).
//   app  -> GET /v1/calendar/feed -> { source: "google", calendar, calendars, events }

import {
  calendarAccountOwns,
  skipGoogleEventForever,
  type GoogleCalendar,
  type GoogleEvent,
  type GoogleEventLabel,
  type GoogleFeed,
} from "@pocketed/shared";
import { CalendarInputError, type Fetcher } from "./calendar";
import type { Store } from "./store";
import {
  backToGoogleApp,
  finishGoogleOAuth,
  googleAccessToken,
  googleApiGet,
  googleReadJson,
  googleProfile,
  MAX_GOOGLE_CONNECTIONS,
  googleGrantStillUsed,
  googleTokenExpiry,
  GOOGLE_TIMEOUT_MS,
  revokeGoogleGrant,
  startGoogleOAuth,
  type GoogleConfig,
} from "./google-oauth";

export { normalizeReturnUrl, type GoogleConfig } from "./google-oauth";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_SCOPES = ["openid", "email", GOOGLE_SCOPE] as const;
const API = "https://www.googleapis.com/calendar/v3";
const DAY = 86_400_000;
/** A day more than the app's 60-day window, so its own filter has the final say. */
const WINDOW_DAYS = 61;
const PAGE_SIZE = 250;
const MAX_PAGES = 4;
const CALENDAR_CONCURRENCY = 4;

const EVENT_FIELDS =
  "nextPageToken,items(id,iCalUID,status,summary,description,location,colorId,eventLabelId," +
  "start,end,originalStartTime,recurringEventId,eventType,attendees(self,responseStatus))";
/** The colour behind an event's `eventLabelId` lives here, not in the calendar list. */
const LABEL_FIELDS = "labelProperties";

export function redirectUriFor(cfg: GoogleConfig, reqUrl: URL): string {
  return cfg.redirectUri || `${reqUrl.origin}/v1/google/callback`;
}

/** Step 1: the Google page the app should open. */
export async function startGoogleSignIn(
  store: Store,
  cfg: GoogleConfig,
  redirectUri: string,
  rawReturnUrl: unknown,
  now: number,
): Promise<string> {
  return startGoogleOAuth(store, cfg, redirectUri, rawReturnUrl, now, "calendar", GOOGLE_CALENDAR_SCOPES);
}

/** Step 2: Google sends the browser back here. Always answers with a page or redirect. */
export async function finishGoogleSignIn(
  store: Store,
  cfg: GoogleConfig,
  redirectUri: string,
  params: URLSearchParams,
  now: number,
  fetcher: Fetcher,
): Promise<Response> {
  const result = await finishGoogleOAuth(
    store, cfg, redirectUri, params, now, fetcher, "calendar",
    [["openid"], ["email", "https://www.googleapis.com/auth/userinfo.email"], [GOOGLE_SCOPE, "https://www.googleapis.com/auth/calendar"]],
    "Pocketed needs permission to see your calendar — tick that box when Google asks.",
  );
  if (result instanceof Response) return result;
  const { returnUrl, tokens: tok } = result;

  let profile: Awaited<ReturnType<typeof googleProfile>>;
  try { profile = await googleProfile(fetcher, tok.access_token); }
  catch { return backToGoogleApp(returnUrl, "calendar", "Couldn't identify your Google account. Try signing in again."); }

  // Also check that the Calendar API is available before storing a new connection.
  let email: string | null = profile.email;
  try {
    const res = await fetcher(`${API}/users/me/calendarList/primary?fields=id`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (res.status === 403) {
      return backToGoogleApp(
        returnUrl, "calendar",
        "Google refused calendar access — is the Google Calendar API enabled in the Google Cloud project?",
      );
    }
    if (res.ok && !email) email = (await googleReadJson<{ id?: string }>(res))?.id ?? null;
  } catch {
    /* not essential */
  }

  // Revoking an old refresh token can revoke this new one and Classroom's
  // grant too. Forget the superseded token without revoking the whole grant.
  const accounts = await store.listGoogle();
  const existing = accounts.find((r) => r.accountId === profile.sub) ??
    accounts.find((r) => !r.accountId && !!email && r.email?.toLowerCase() === email.toLowerCase());
  if (!existing && accounts.length >= MAX_GOOGLE_CONNECTIONS) {
    return backToGoogleApp(returnUrl, "calendar", `You can connect up to ${MAX_GOOGLE_CONNECTIONS} Calendar accounts. Disconnect one before adding another.`);
  }
  const id = existing?.id ?? `google:${profile.sub}`;
  await store.setGoogle({
    id, accountId: profile.sub,
    legacyIds: existing?.legacyIds ?? !!(await store.getCalendar()),
    visible: existing?.visible ?? true,
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessExpires: googleTokenExpiry(now, tok.expires_in),
    email,
    connectedAt: Math.max(now, (existing?.connectedAt ?? 0) + 1),
    problem: null,
  });
  // One calendar source at a time: signing in replaces a secret link.
  await store.setCalendar(null);
  return backToGoogleApp(returnUrl, "calendar", undefined, id);
}

/** Forget only the chosen Calendar connection; Classroom and other accounts stay. */
export async function disconnectGoogle(store: Store, fetcher: Fetcher, id?: string, now = Date.now()): Promise<number> {
  const rows = id === undefined ? await store.listGoogle() : [await store.getGoogle(id)].filter((r) => r !== null);
  let removed = 0;
  for (const row of rows) {
    // Remove credentials before cleanup, so a late feed fails its identity check.
    await store.removeGoogle(row.id);
    for (const note of await store.allNotes()) {
      if (!calendarAccountOwns(note, { accountId: row.id, legacyIds: row.legacyIds }) || note.deleted) continue;
      await store.appendOp({ id: crypto.randomUUID(), kind: "delete", noteId: note.id, updatedAt: Math.max(now, note.updatedAt),
        source: "gcal", sourceRef: "calendar-removed", sourceAccountId: row.id });
      removed++;
    }
    if (!(await googleGrantStillUsed(store, row.accountId))) {
      await revokeGoogleGrant(fetcher, row.refreshToken);
    }
  }
  return removed;
}

const SIGN_IN_AGAIN =
  "Google no longer accepts Pocketed's sign-in (it may have been removed or expired). " +
  "Sign in with Google again in Settings.";

/** Upcoming events from every readable calendar on the account, with colours. */
export async function googleFeed(
  store: Store,
  cfg: GoogleConfig,
  now: number,
  fetcher: Fetcher,
  accountId?: string,
): Promise<GoogleFeed> {
  const row = await store.getGoogle(accountId);
  if (!row) throw new CalendarInputError("No calendar connected.", 409);

  let token = await googleAccessToken(row, cfg, now, fetcher, (r) => store.updateGoogleTokens(r), SIGN_IN_AGAIN);
  let refreshing: Promise<string> | null = null;
  // GET with one retry on 401 (a token revoked/rotated early).
  const get = async <T>(url: string): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const used = token;
      const r = await googleApiGet<T>(fetcher, url, used, "Calendar");
      if (r.status === 401 && attempt === 0) {
        if (token === used) {
          refreshing ??= googleAccessToken(row, cfg, now, fetcher, (r) => store.updateGoogleTokens(r), SIGN_IN_AGAIN, true);
          token = await refreshing;
        }
        continue;
      }
      if (r.status === 403) {
        throw new CalendarInputError(
          "Google refused calendar access (403) — is the Google Calendar API enabled, and was the calendar permission granted?",
          502,
        );
      }
      if (r.status !== 200 || !r.body) {
        throw new CalendarInputError(`Google Calendar answered with an error (${r.status}).`, 502);
      }
      return r.body;
    }
  };

  const base = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    // Cancelled/deleted events come through as such (status "cancelled"), which
    // lets the app remove their reminders on the calendar's word instead of
    // guessing from an absence that might just be a partial feed.
    showDeleted: "true",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + WINDOW_DAYS * DAY).toISOString(),
    maxResults: String(PAGE_SIZE),
    maxAttendees: "1", // just enough to see your own reply
    fields: EVENT_FIELDS,
  });
  // Include owned, shared and subscribed calendars, even if hidden/unchecked
  // in Google's UI. Free/busy-only calendars cannot supply event details.
  type CalendarEntry = GoogleCalendar & { accessRole?: string; deleted?: boolean };
  type CalendarPage = { items?: CalendarEntry[]; nextPageToken?: string };
  const calendars = new Map<string, GoogleCalendar>();
  let listToken: string | undefined;
  for (let i = 0; ; i++) {
    const q = new URLSearchParams({
      minAccessRole: "reader",
      showHidden: "true",
      maxResults: String(PAGE_SIZE),
      fields: "nextPageToken,items(id,primary,colorId,backgroundColor,accessRole,deleted)",
    });
    if (listToken) q.set("pageToken", listToken);
    const page = await get<CalendarPage>(`${API}/users/me/calendarList?${q}`);
    for (const cal of page.items ?? []) {
      if (!cal.id || cal.deleted || !["reader", "writer", "owner"].includes(cal.accessRole ?? "")) continue;
      calendars.set(cal.id, {
        id: cal.id,
        primary: cal.primary === true,
        colorId: cal.colorId,
        backgroundColor: cal.backgroundColor,
      });
    }
    if (!page.nextPageToken) break;
    // Never return a partial snapshot: reconciliation would delete reminders
    // belonging to calendars/events that we hadn't fetched yet.
    if (i + 1 >= MAX_PAGES) {
      throw new CalendarInputError(
        "Google returned too many calendars to import safely. Existing reminders were kept.",
        502,
      );
    }
    listToken = page.nextPageToken;
  }

  type Page = { items?: GoogleEvent[]; nextPageToken?: string };
  const events: GoogleEvent[] = [];
  // Bound concurrent Google requests rather than firing one per calendar.
  const allCalendars = [...calendars.values()];
  for (let offset = 0; offset < allCalendars.length; offset += CALENDAR_CONCURRENCY) {
    const batches = await Promise.all(allCalendars.slice(offset, offset + CALENDAR_CONCURRENCY).map(async (cal) => {
      const items: GoogleEvent[] = [];
      let pageToken: string | undefined;
      for (let i = 0; ; i++) {
        const q = new URLSearchParams(base);
        if (pageToken) q.set("pageToken", pageToken);
        const page = await get<Page>(`${API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
        for (const ev of page.items ?? []) {
          // Cancelled events are kept: the app needs them to know which
          // reminders to remove. Declined invitations and working-location
          // markers are simply not appointments.
          if (!skipGoogleEventForever(ev)) items.push({ ...ev, calendarId: cal.id });
        }
        if (!page.nextPageToken) break;
        if (i + 1 >= MAX_PAGES) {
          throw new CalendarInputError(
            "Google returned too many events to import safely. Existing reminders were kept.",
            502,
          );
        }
        pageToken = page.nextPageToken;
      }
      return items;
    }));
    for (const batch of batches) events.push(...batch);
  }

  // Since June 2026 an event can wear any of Google's 24 colours, or one of up
  // to 200 custom shades per calendar; those arrive as a label id only, so the
  // colour has to be fetched from the calendar resource. Only the calendars
  // that actually have a labelled event are asked. (Google sends `eventLabelId`
  // and the legacy `colorId` together without being asked, so we don't set
  // eventLabelVersion=1 — with it set, Google ignores `colorId`, and that is
  // our fallback for a calendar whose labels we couldn't read.)
  const usedLabels = new Map<string, Set<string>>();
  for (const ev of events) {
    if (!ev.eventLabelId || !ev.calendarId) continue;
    const used = usedLabels.get(ev.calendarId) ?? new Set<string>();
    used.add(ev.eventLabelId);
    usedLabels.set(ev.calendarId, used);
  }
  const labelledIds = [...usedLabels.keys()];
  for (let offset = 0; offset < labelledIds.length; offset += CALENDAR_CONCURRENCY) {
    const batch = await Promise.all(
      labelledIds.slice(offset, offset + CALENDAR_CONCURRENCY).map(async (id) => {
        try {
          const cal = await get<{ labelProperties?: { eventLabels?: GoogleEventLabel[] } }>(
            `${API}/calendars/${encodeURIComponent(id)}?fields=${LABEL_FIELDS}`,
          );
          // A calendar can hold 200 labels; only the ones its events wear are worth relaying.
          return (cal.labelProperties?.eventLabels ?? []).filter((l) => usedLabels.get(id)?.has(l?.id));
        } catch {
          // A colour we can't read isn't worth failing the import over: the
          // event keeps its legacy colour id, or its calendar's colour.
          return null;
        }
      }),
    );
    batch.forEach((labels, i) => {
      const cal = calendars.get(labelledIds[offset + i]);
      if (cal && labels?.length) cal.eventLabels = labels;
    });
  }

  // Another device may disconnect or reconnect this account while Google responds.
  const current = await store.getGoogle(row.id);
  if (!current) throw new CalendarInputError("No calendar connected.", 409);
  if (current.refreshToken !== row.refreshToken || current.connectedAt !== row.connectedAt) {
    throw new CalendarInputError("The Calendar connection changed while checking. Existing reminders were kept; check again.", 502);
  }
  const primary = allCalendars.find((cal) => cal.primary);
  return {
    source: "google",
    accountId: row.id,
    legacyIds: row.legacyIds,
    calendar: { colorId: primary?.colorId, backgroundColor: primary?.backgroundColor },
    calendars: allCalendars,
    events,
  };
}
