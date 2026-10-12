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
  skipGoogleEvent,
  type GoogleCalendar,
  type GoogleEvent,
  type GoogleEventLabel,
  type GoogleFeed,
} from "@pocketed/shared";
import { CalendarInputError, type Fetcher } from "./calendar";
import type { GoogleAccountRow, Store } from "./store";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Overrides `${worker origin}/v1/google/callback` (custom domains, proxies). */
  redirectUri?: string;
}

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
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

/**
 * Where to send the browser after Google: the app's own page. Only https
 * (or http on this machine, for development), without credentials, query or
 * fragment.
 */
export function normalizeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return null;
  return u.origin + u.pathname;
}

function randomState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Step 1: the Google page the app should open. */
export async function startGoogleSignIn(
  store: Store,
  cfg: GoogleConfig,
  redirectUri: string,
  rawReturnUrl: unknown,
  now: number,
): Promise<string> {
  const returnUrl = normalizeReturnUrl(rawReturnUrl);
  if (!returnUrl) throw new CalendarInputError("Pocketed's address couldn't be used to come back to.");
  const state = randomState();
  await store.putOAuthState(state, returnUrl, now + STATE_TTL_MS, now);
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline", // a refresh token, so imports keep working
    prompt: "consent", // …issued again on every sign-in
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_URL}?${q}`;
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
}

function backToApp(returnUrl: string, error?: string): Response {
  return redirect(
    error
      ? `${returnUrl}#google=error&message=${encodeURIComponent(error)}`
      : `${returnUrl}#google=connected`,
  );
}

function plainPage(message: string, status: number): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Pocketed</title><body style="font-family:system-ui;padding:2rem;max-width:32rem">` +
    `<h1 style="font-size:1.2rem">Pocketed</h1><p>${message}</p></body>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

async function postForm(fetcher: Fetcher, url: string, form: Record<string, string>) {
  return fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
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
  const state = params.get("state") ?? "";
  const returnUrl = state ? await store.takeOAuthState(state, now) : null;
  if (!returnUrl) {
    return plainPage(
      "This sign-in link has expired or was already used. Go back to Pocketed and choose " +
        "“Sign in with Google” again.",
      400,
    );
  }
  if (params.get("error")) {
    return backToApp(
      returnUrl,
      params.get("error") === "access_denied"
        ? "Google sign-in was cancelled."
        : `Google sign-in failed (${params.get("error")}).`,
    );
  }
  const code = params.get("code");
  if (!code) return backToApp(returnUrl, "Google didn't send a sign-in code. Try again.");

  let tok: TokenResponse | null = null;
  try {
    const res = await postForm(fetcher, TOKEN_URL, {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    tok = await readJson<TokenResponse>(res);
    if (!res.ok) tok = { error: tok?.error ?? `HTTP ${res.status}` };
  } catch {
    return backToApp(returnUrl, "Couldn't reach Google. Try again in a minute.");
  }
  if (!tok || tok.error || !tok.access_token) {
    return backToApp(
      returnUrl,
      `Google didn't accept the sign-in (${tok?.error ?? "no token"}). Check the server's Google settings.`,
    );
  }
  const scopes = (tok.scope ?? "").split(/\s+/);
  if (!scopes.includes(GOOGLE_SCOPE) && !scopes.includes("https://www.googleapis.com/auth/calendar")) {
    return backToApp(
      returnUrl,
      "Pocketed needs permission to see your calendar — tick that box when Google asks.",
    );
  }
  if (!tok.refresh_token) {
    return backToApp(returnUrl, "Google didn't allow ongoing access. Try signing in again.");
  }

  // The primary calendar's id is the account's address — shown in Settings.
  let email: string | null = null;
  try {
    const res = await fetcher(`${API}/users/me/calendarList/primary?fields=id`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403) {
      return backToApp(
        returnUrl,
        "Google refused calendar access — is the Google Calendar API enabled in the Google Cloud project?",
      );
    }
    if (res.ok) email = (await readJson<{ id?: string }>(res))?.id ?? null;
  } catch {
    /* not essential */
  }

  const old = await store.getGoogle();
  if (old && old.refreshToken !== tok.refresh_token) await revoke(fetcher, old.refreshToken);
  await store.setGoogle({
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessExpires: now + Math.max(60, tok.expires_in ?? 3600) * 1000,
    email,
    connectedAt: now,
    problem: null,
  });
  // One calendar source at a time: signing in replaces a secret link.
  await store.setCalendar(null);
  return backToApp(returnUrl);
}

async function revoke(fetcher: Fetcher, token: string): Promise<void> {
  try {
    await postForm(fetcher, REVOKE_URL, { token });
  } catch {
    /* best effort */
  }
}

/** Forgets the Google connection and tells Google to drop Pocketed's access. */
export async function disconnectGoogle(store: Store, fetcher: Fetcher): Promise<void> {
  const row = await store.getGoogle();
  if (!row) return;
  await store.setGoogle(null);
  await revoke(fetcher, row.refreshToken);
}

const SIGN_IN_AGAIN =
  "Google no longer accepts Pocketed's sign-in (it may have been removed or expired). " +
  "Sign in with Google again in Settings.";

async function accessToken(
  store: Store,
  row: GoogleAccountRow,
  cfg: GoogleConfig,
  now: number,
  fetcher: Fetcher,
  force: boolean,
): Promise<string> {
  if (!force && row.accessToken && row.accessExpires && row.accessExpires > now + 60_000) {
    return row.accessToken;
  }
  let res: Response;
  try {
    res = await postForm(fetcher, TOKEN_URL, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: row.refreshToken,
      grant_type: "refresh_token",
    });
  } catch {
    throw new CalendarInputError("Couldn't reach Google. Try again in a minute.", 502);
  }
  const tok = await readJson<TokenResponse>(res);
  if (!res.ok || !tok?.access_token) {
    if (tok?.error === "invalid_grant") {
      await store.setGoogle({ ...row, accessToken: null, accessExpires: null, problem: SIGN_IN_AGAIN });
      throw new CalendarInputError(SIGN_IN_AGAIN, 502);
    }
    throw new CalendarInputError(
      `Google sign-in check failed (${tok?.error ?? res.status}). Check the server's Google settings.`,
      502,
    );
  }
  const next: GoogleAccountRow = {
    ...row,
    accessToken: tok.access_token,
    accessExpires: now + Math.max(60, tok.expires_in ?? 3600) * 1000,
    problem: null,
  };
  await store.setGoogle(next);
  Object.assign(row, next);
  return tok.access_token;
}

async function apiGet<T>(fetcher: Fetcher, url: string, token: string): Promise<{ status: number; body: T | null }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CalendarInputError("Couldn't reach Google Calendar. Try again in a minute.", 502);
  }
  return { status: res.status, body: res.ok ? await readJson<T>(res) : null };
}

/** Upcoming events from every readable calendar on the account, with colours. */
export async function googleFeed(
  store: Store,
  cfg: GoogleConfig,
  now: number,
  fetcher: Fetcher,
): Promise<GoogleFeed> {
  const row = await store.getGoogle();
  if (!row) throw new CalendarInputError("No calendar connected.", 409);

  let token = await accessToken(store, row, cfg, now, fetcher, false);
  let refreshing: Promise<string> | null = null;
  // GET with one retry on 401 (a token revoked/rotated early).
  const get = async <T>(url: string): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const used = token;
      const r = await apiGet<T>(fetcher, url, used);
      if (r.status === 401 && attempt === 0) {
        if (token === used) {
          refreshing ??= accessToken(store, row, cfg, now, fetcher, true);
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
          if (!skipGoogleEvent(ev)) items.push({ ...ev, calendarId: cal.id });
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

  const primary = allCalendars.find((cal) => cal.primary);
  return {
    source: "google",
    calendar: { colorId: primary?.colorId, backgroundColor: primary?.backgroundColor },
    calendars: allCalendars,
    events,
  };
}
