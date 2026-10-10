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
import { D1Store, type Store } from "./store";

export interface Env {
  DB: D1Database;
  /** Optional: enable "Sign in with Google" (see SETUP.md). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

export function googleConfig(env: Partial<Env>): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret, redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || undefined };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
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
    return json({ ...page, serverSeq: await store.serverSeq() });
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
        await connectCalendar(store, body?.url, now(), fetcher);
        // One source at a time: a secret link replaces a Google sign-in.
        await disconnectGoogle(store, fetcher);
        return json(await status());
      }
      if (url.pathname === "/v1/calendar/feed" && req.method === "GET") {
        if (await store.getGoogle()) {
          if (!google) {
            throw new CalendarInputError(
              "Sign in with Google is no longer set up on this server. Connect the calendar again in Settings.",
              502,
            );
          }
          const feed = await googleFeed(store, google, now(), fetcher);
          return new Response(JSON.stringify(feed), {
            headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
          });
        }
        return await proxyFeed(store, fetcher, CORS);
      }
      if (url.pathname === "/v1/calendar/disconnect" && req.method === "POST") {
        await disconnectGoogle(store, fetcher);
        await store.setCalendar(null);
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
    return json({
      notes: await store.allNotes(),
      sections: await store.allSections(),
      serverSeq: await store.serverSeq(),
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
