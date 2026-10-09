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

import {
  LIMITS,
  passwordError,
  validateOp,
  type Op,
} from "@pocketed/shared";
import { hashWithSalt, newSalt } from "./auth";
import { D1Store, type Store } from "./store";

export interface Env {
  DB: D1Database;
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

export async function handle(req: Request, store: Store): Promise<Response> {
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

  if (url.pathname === "/v1/snapshot" && req.method === "GET") {
    return json({ notes: await store.allNotes(), serverSeq: await store.serverSeq() });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB);
    await store.init();
    return handle(req, store);
  },
};
