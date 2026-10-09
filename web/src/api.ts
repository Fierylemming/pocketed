import type { Note, Op } from "@pocketed/shared";
import type { Config } from "./config";

export class ApiError extends Error {
  constructor(public status: number) {
    super("api error " + status);
  }
}

const base = (serverUrl: string) => serverUrl.replace(/\/+$/, "");

async function req<T>(cfg: Config, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base(cfg.serverUrl) + path, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!r.ok) throw new ApiError(r.status);
  return (await r.json()) as T;
}

async function publicReq<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(base(serverUrl) + path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : {},
  });
  if (!r.ok) throw new ApiError(r.status);
  return (await r.json()) as T;
}

export const api = {
  health: (serverUrl: string) =>
    publicReq<{ ok: boolean; initialized: boolean }>(serverUrl, "/health"),

  init: (serverUrl: string, password: string, recovery: string) =>
    publicReq<{ ok: boolean }>(serverUrl, "/v1/init", {
      method: "POST",
      body: JSON.stringify({ password, recovery }),
    }),

  recover: (serverUrl: string, recovery: string, password: string) =>
    publicReq<{ ok: boolean }>(serverUrl, "/v1/recover", {
      method: "POST",
      body: JSON.stringify({ recovery, password }),
    }),

  pull: (cfg: Config, cursor: number) =>
    req<{ ops: Op[]; cursor: number; serverSeq: number }>(
      cfg,
      `/v1/pull?cursor=${cursor}&limit=1000`,
    ),

  push: (cfg: Config, ops: Op[]) =>
    req<{ serverSeq: number }>(cfg, "/v1/push", {
      method: "POST",
      body: JSON.stringify({ ops }),
    }),

  snapshot: (cfg: Config) =>
    req<{ notes: Note[]; serverSeq: number }>(cfg, "/v1/snapshot"),

  changePassword: (cfg: Config, password: string) =>
    req<{ ok: boolean }>(cfg, "/v1/password", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  rotateRecovery: (cfg: Config, recovery: string) =>
    req<{ ok: boolean }>(cfg, "/v1/recovery", {
      method: "POST",
      body: JSON.stringify({ recovery }),
    }),
};
