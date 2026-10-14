// Pocketed sync server v2.1 — auth lives in the database, managed entirely
// from the apps (no terminal, no dashboard):
//
//   GET  /health             public; includes `initialized`
//   POST /v1/init            first-run only: { password, recovery }
//   POST /v1/recover         { recovery, password }  (forgot-password)
//   POST /v1/push            bearer = password
//   GET  /v1/pull?cursor=N   bearer = password
//   GET  /v1/snapshot        bearer = password
//   POST /v1/password        bearer = old password; { password } = new
//   POST /v1/recovery        bearer = password; { recovery } = new recovery key
//
// Google Calendar link (secret iCal address). The apps parse the feed and
// turn events into reminders; the server only stores and relays the link:
//   GET  /v1/calendar             status (never returns the secret link)
//   POST /v1/calendar             { url } check and save / replace the link
//   GET  /v1/calendar/feed        the calendar: .ics streamed through, or JSON
//                                 events with colours when signed in with Google
//   POST /v1/calendar/disconnect  forget the link / Google sign-in
//
// Sign in with Google (needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET secrets):
//   POST /v1/google/start         { returnUrl } -> { url } of Google's consent page
//   GET  /v1/google/callback      public; Google returns here, then back to the app
//
// Classroom assignments (student-only, read-only, independent of Calendar):
//   GET  /v1/classroom            safe connection status
//   POST /v1/classroom/start      { returnUrl } -> Google's consent URL
//   GET  /v1/classroom/callback   public; one-time state bound to Classroom
//   GET  /v1/classroom/feed       full published coursework for active student classes
//   POST /v1/classroom/disconnect forget tokens and remove only Classroom reminders

import {
  LIMITS,
  passwordError,
  validateOp,
  type Op,
} from "@pocketed/shared";
import { hashWithSalt, newSalt } from "./auth";
import {
  calendarStatus,
  CalendarInputError,
  connectCalendar,
  proxyFeed,
  type Fetcher,
} from "./calendar";
import {
  disconnectGoogle,
  finishGoogleSignIn,
  googleFeed,
  redirectUriFor,
  startGoogleSignIn,
  type GoogleConfig,
} from "./google";
import {
  classroomFeed,
  classroomRedirectUriFor,
  classroomStatus,
  disconnectClassroom,
  finishClassroomSignIn,
  startClassroomSignIn,
} from "./classroom";
import { D1Store, type Store } from "./store";

export interface Env {
  DB: D1Database;
  /** Optional: enable "Sign in with Google" (see SETUP.md). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_CLASSROOM_REDIRECT_URI?: string;
}

export function googleConfig(env: Partial<Env>): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId, clientSecret,
    redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || undefined,
    classroomRedirectUri: env.GOOGLE_CLASSROOM_REDIRECT_URI?.trim() || undefined,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function selectedAccount(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > LIMITS.sourceAccountIdChars) {
    throw new CalendarInputError("A valid accountId is required.");
  }
  return value;
}

/** Injectable for tests. */
export interface Deps {
  fetch?: Fetcher;
  now?: () => number;
  /** Present when "Sign in with Google" is set up. */
  google?: GoogleConfig;
}

export async function handle(req: Request, store: Store, deps: Deps = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const fetcher: Fetcher = deps.fetch ?? ((u, i) => fetch(u, i));
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (url.pathname === "/health") {
    return json({
      ok: true,
      service: "pocketed",
      version: "2",
      notes: await store.noteCount(),
      initialized: (await store.getAuth()) !== null,
    });
  }

  // ---- Google sends the browser back here (public; protected by the one-time state) ----
  if (url.pathname === "/v1/google/callback" && req.method === "GET") {
    if (!deps.google) return json({ error: "Sign in with Google isn't set up on this server." }, 404);
    return finishGoogleSignIn(
      store,
      deps.google,
      redirectUriFor(deps.google, url),
      url.searchParams,
      now(),
      fetcher,
    );
  }

  if (url.pathname === "/v1/classroom/callback" && req.method === "GET") {
    if (!deps.google) return json({ error: "Google Classroom isn't set up on this server." }, 404);
    return finishClassroomSignIn(
      store, deps.google, classroomRedirectUriFor(deps.google, url), url.searchParams, now(), fetcher,
    );
  }

  // ---- public auth-setup endpoints ----

  if (url.pathname === "/v1/init" && req.method === "POST") {
    if (await store.getAuth()) return json({ error: "already initialized" }, 409);
    const body = await readJson(req);
    const password = typeof body?.password === "string" ? body.password : "";
    const recovery = typeof body?.recovery === "string" ? body.recovery : "";
    const err = passwordError(password);
    if (err) return json({ error: err }, 400);
    if (!recovery) return json({ error: "recovery key missing" }, 400);
    const salt = newSalt();
    await store.setAuth({
      salt,
      passHash: await hashWithSalt(password, salt),
      recoveryHash: await hashWithSalt(recovery, salt),
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/recover" && req.method === "POST") {
    const auth = await store.getAuth();
    if (!auth) return json({ error: "not initialized" }, 409);
    const body = await readJson(req);
    const recovery = typeof body?.recovery === "string" ? body.recovery : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const err = passwordError(password);
    if (err) return json({ error: err }, 400);
    const ok = (await hashWithSalt(recovery, auth.salt)) === auth.recoveryHash;
    if (!ok) return json({ error: "wrong recovery key" }, 401);
    await store.setAuth({
      ...auth,
      passHash: await hashWithSalt(password, auth.salt),
    });
    return json({ ok: true });
  }

  // ---- everything else needs the password ----

  const auth = await store.getAuth();
  const got = bearer(req);
  const authorized =
    auth !== null &&
    got.length >= 8 &&
    (await hashWithSalt(got, auth.salt)) === auth.passHash;
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  if (!authorized) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/v1/password" && req.method === "POST") {
    const body = await readJson(req);
    const password = typeof body?.password === "string" ? body.password : "";
    const err = passwordError(password);
    if (err) return json({ error: err }, 400);
    await store.setAuth({
      ...auth!,
      passHash: await hashWithSalt(password, auth!.salt),
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/recovery" && req.method === "POST") {
    const body = await readJson(req);
    const recovery = typeof body?.recovery === "string" ? body.recovery : "";
    if (!recovery) return json({ error: "recovery key missing" }, 400);
    await store.setAuth({
      ...auth!,
      recoveryHash: await hashWithSalt(recovery, auth!.salt),
    });
    return json({ ok: true });
  }

  if (url.pathname === "/v1/push" && req.method === "POST") {
    const body = await readJson(req);
    const ops = (body?.ops ?? null) as Op[] | null;
    if (!Array.isArray(ops)) return json({ error: "ops must be an array" }, 400);
    if (ops.length > LIMITS.opsPerPush) return json({ error: "too many ops" }, 400);
    for (const op of ops) {
      const err = validateOp(op);
      if (err) return json({ error: err }, 400);
    }
    for (const op of ops) await store.appendOp(op);
    return json({ serverSeq: await store.serverSeq() });
  }

  if (url.pathname === "/v1/pull" && req.method === "GET") {
    const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
    const limit = Math.min(
      LIMITS.opsPerPull,
      Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200),
    );
    const page = await store.listOps(cursor, limit);
    const accountState = await store.getGoogleState();
    return json({ ...page, serverSeq: await store.serverSeq(), calendarAccounts: accountState.accounts, calendarAccountsRevision: accountState.revision });
  }

  // ---- Classroom: separate credentials and reminder source from Calendar ----
  if (url.pathname === "/v1/classroom" || url.pathname.startsWith("/v1/classroom/")) {
    const google = deps.google;
    try {
      if (url.pathname === "/v1/classroom" && req.method === "GET") {
        return json(await classroomStatus(store, !!google));
      }
      if (url.pathname === "/v1/classroom/start" && req.method === "POST") {
        if (!google) return json({ error: "Google Classroom needs the server's Google OAuth settings (see SETUP.md)." }, 501);
        const body = await readJson(req);
        const authUrl = await startClassroomSignIn(
          store, google, classroomRedirectUriFor(google, url), body?.returnUrl, now(),
        );
        return json({ url: authUrl });
      }
      if (url.pathname === "/v1/classroom/feed" && req.method === "GET") {
        const accountId = selectedAccount(url.searchParams.get("accountId") ?? undefined);
        const rows = await store.listClassroom();
        if (accountId === undefined && rows.length > 1) throw new CalendarInputError("Choose a Classroom account to check (accountId is required).");
        if (!(await store.getClassroom(accountId))) return json({ error: "No Classroom account connected." }, 409);
        if (!google) return json({ error: "Google Classroom is no longer set up on this server. Check the server's Google OAuth settings." }, 502);
        return new Response(JSON.stringify(await classroomFeed(store, google, now(), fetcher, accountId)), {
          headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
        });
      }
      if (url.pathname === "/v1/classroom/disconnect" && req.method === "POST") {
        const body = await readJson(req);
        const accountId = selectedAccount(body?.accountId);
        if (accountId === undefined && (await store.listClassroom()).length > 1) throw new CalendarInputError("Choose a Classroom account to disconnect (accountId is required).");
        if (accountId !== undefined && !(await store.getClassroom(accountId))) throw new CalendarInputError("That Classroom account is no longer connected.", 404);
        const removed = await disconnectClassroom(store, now(), fetcher, accountId);
        return json({ ...await classroomStatus(store, !!google), removed });
      }
    } catch (e) {
      if (e instanceof CalendarInputError) return json({ error: e.message }, e.status);
      throw e;
    }
    return json({ error: "not found" }, 404);
  }

  // ---- calendar (secret link or Google sign-in) ----

  if (url.pathname.startsWith("/v1/calendar") || url.pathname.startsWith("/v1/google/")) {
    const google = deps.google;
    const status = () => calendarStatus(store, !!google);
    try {
      if (url.pathname === "/v1/calendar" && req.method === "GET") {
        return json(await status());
      }
      if (url.pathname === "/v1/calendar" && req.method === "POST") {
        const body = await readJson(req);
        if ((await store.listGoogle()).length > 1 && body?.replaceGoogle !== true) {
          throw new CalendarInputError("A secret link replaces every connected Calendar account. Confirm replacement first.", 409);
        }
        await connectCalendar(store, body?.url, now(), fetcher);
        // Secret-link mode remains an alternative to Google Calendar accounts.
        await disconnectGoogle(store, fetcher, undefined, now());
        return json(await status());
      }
      if (url.pathname === "/v1/calendar/feed" && req.method === "GET") {
        const accountId = selectedAccount(url.searchParams.get("accountId") ?? undefined);
        const rows = await store.listGoogle();
        if (accountId === undefined && rows.length > 1) throw new CalendarInputError("Choose a Calendar account to check (accountId is required).");
        if (accountId !== undefined && !(await store.getGoogle(accountId))) throw new CalendarInputError("No calendar connected.", 409);
        if (rows.length) {
          if (!google) {
            throw new CalendarInputError(
              "Sign in with Google is no longer set up on this server. Connect the calendar again in Settings.",
              502,
            );
          }
          const feed = await googleFeed(store, google, now(), fetcher, accountId);
          return new Response(JSON.stringify(feed), {
            headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
          });
        }
        return await proxyFeed(store, fetcher, CORS);
      }
      if (url.pathname === "/v1/calendar/disconnect" && req.method === "POST") {
        const body = await readJson(req);
        const accountId = selectedAccount(body?.accountId);
        if (accountId === undefined && (await store.listGoogle()).length > 1) throw new CalendarInputError("Choose a Calendar account to disconnect (accountId is required).");
        if (accountId !== undefined && !(await store.getGoogle(accountId))) throw new CalendarInputError("That Calendar account is no longer connected.", 404);
        await disconnectGoogle(store, fetcher, accountId, now());
        if (accountId === undefined) {
          await store.setCalendar(null);
          // Secret-link reminders have no account ID. Cleanup is synced too.
          for (const note of await store.allNotes()) {
            if (note.source === "gcal" && !note.deleted) await store.appendOp({
              id: crypto.randomUUID(), kind: "delete", noteId: note.id, updatedAt: Math.max(now(), note.updatedAt),
              source: "gcal", sourceRef: "calendar-removed", sourceAccountId: note.sourceAccountId ?? null,
            });
          }
        }
        return json(await status());
      }
      if (url.pathname === "/v1/calendar/visibility" && req.method === "POST") {
        const body = await readJson(req);
        const accountId = selectedAccount(body?.accountId);
        if (!accountId || typeof body?.visible !== "boolean") throw new CalendarInputError("accountId and visible (true or false) are required.");
        if (!(await store.setGoogleVisibility(accountId, body.visible))) throw new CalendarInputError("That Calendar account is no longer connected.", 404);
        // A visibility change never deletes reminders, changes Classroom, or revokes tokens.
        return json(await status());
      }
      if (url.pathname === "/v1/google/start" && req.method === "POST") {
        if (!google) {
          return json({ error: "Sign in with Google isn't set up on this server yet (see SETUP.md)." }, 501);
        }
        const body = await readJson(req);
        const authUrl = await startGoogleSignIn(
          store,
          google,
          redirectUriFor(google, url),
          body?.returnUrl,
          now(),
        );
        return json({ url: authUrl });
      }
    } catch (e) {
      if (e instanceof CalendarInputError) return json({ error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/v1/snapshot" && req.method === "GET") {
    const accountState = await store.getGoogleState();
    return json({
      notes: await store.allNotes(),
      sections: await store.allSections(),
      serverSeq: await store.serverSeq(),
      calendarAccounts: accountState.accounts,
      calendarAccountsRevision: accountState.revision,
    });
  }

  return json({ error: "not found" }, 404);
}

// The schema check is idempotent but costs D1 round-trips, so run it once per
// worker instance rather than on every request. A failed attempt is retried.
let schemaReady: Promise<void> | null = null;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB);
    schemaReady ??= store.init().catch((e) => {
      schemaReady = null;
      throw e;
    });
    await schemaReady;
    return handle(req, store, { google: googleConfig(env) });
  },
};
