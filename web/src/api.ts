import type { Note, Op } from "@pocketed/shared";
import type { Config } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    /** The server's own explanation, when it sent one. */
    public detail?: string,
  ) {
    super(detail ?? "api error " + status);
  }
}

export interface CalendarStatus {
  connected: boolean;
  /** e.g. "calendar.google.com · …/basic.ics" (never the secret link). */
  feed: string | null;
  connectedAt: number | null;
}

async function errorFrom(r: Response): Promise<ApiError> {
  let detail: string | undefined;
  try {
    const body = (await r.json()) as { error?: unknown };
    if (typeof body?.error === "string") detail = body.error;
  } catch {
    /* not JSON */
  }
  return new ApiError(r.status, detail);
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
  if (!r.ok) throw await errorFrom(r);
  return (await r.json()) as T;
}

async function reqText(cfg: Config, path: string): Promise<string> {
  const r = await fetch(base(cfg.serverUrl) + path, {
    headers: { authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
  });
  if (!r.ok) throw await errorFrom(r);
  return r.text();
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

  pull: (cfg: Config, cursor: number, limit = 1000) =>
    req<{ ops: Op[]; cursor: number; serverSeq: number }>(
      cfg,
      `/v1/pull?cursor=${cursor}&limit=${limit}`,
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

  calendarStatus: (cfg: Config) => req<CalendarStatus>(cfg, "/v1/calendar"),

  /** Checks the link on the server and saves it. */
  connectCalendar: (cfg: Config, url: string) =>
    req<CalendarStatus>(cfg, "/v1/calendar", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  /** The connected calendar as .ics text (409 when none is connected). */
  calendarFeed: (cfg: Config) => reqText(cfg, "/v1/calendar/feed"),

  disconnectCalendar: (cfg: Config) =>
    req<CalendarStatus>(cfg, "/v1/calendar/disconnect", {
      method: "POST",
      body: "{}",
    }),
};
