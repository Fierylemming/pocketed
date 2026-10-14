import {
  isClassroomFeed,
  type CalendarAccountSummary,
  isGoogleFeed,
  type ClassroomFeed,
  type GoogleFeed,
  type Note,
  type Op,
} from "@pocketed/shared";
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
  accounts?: CalendarAccountSummary[];
  accountsRevision?: number;
  /** "google" = signed in with Google (colours); "ical" = secret link. */
  mode?: "google" | "ical" | null;
  /** The Google account, or e.g. "calendar.google.com · …/basic.ics" (never the secret link). */
  feed: string | null;
  connectedAt: number | null;
  /** The server is set up for "Sign in with Google". */
  googleAvailable?: boolean;
  /** Something to fix, e.g. sign in to Google again. */
  problem?: string | null;
}

export interface ClassroomAccountSummary {
  id: string;
  email: string | null;
  connectedAt: number;
  problem: string | null;
  legacyNotes: boolean;
}

export interface ClassroomStatus {
  connected: boolean;
  accounts?: ClassroomAccountSummary[];
  googleAvailable: boolean;
  account: string | null;
  connectedAt: number | null;
  problem: string | null;
}

export interface ClassroomDisconnectResult extends ClassroomStatus {
  removed: number;
}

/** The connected calendar: .ics text (secret link) or Google events with colours. */
export type CalendarFeedData = { kind: "ics"; text: string } | { kind: "google"; feed: GoogleFeed };

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

const accountQuery = (id?: string) => id === undefined ? "" : `?accountId=${encodeURIComponent(id)}`;

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

async function reqFeed(cfg: Config, path: string): Promise<CalendarFeedData> {
  const r = await fetch(base(cfg.serverUrl) + path, {
    headers: { authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
  });
  if (!r.ok) throw await errorFrom(r);
  if (/json/i.test(r.headers.get("content-type") ?? "")) {
    const body: unknown = await r.json();
    if (!isGoogleFeed(body)) throw new Error("The calendar couldn't be read.");
    return { kind: "google", feed: body };
  }
  return { kind: "ics", text: await r.text() };
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
    req<{ ops: Op[]; cursor: number; serverSeq: number; calendarAccounts?: CalendarAccountSummary[]; calendarAccountsRevision?: number }>(
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

  calendarStatus: (cfg: Config) => req<CalendarStatus>(cfg, "/v1/calendar", { cache: "no-store" }),

  /** Checks the link on the server and saves it. */
  connectCalendar: (cfg: Config, url: string, replaceGoogle = false) =>
    req<CalendarStatus>(cfg, "/v1/calendar", {
      method: "POST",
      body: JSON.stringify({ url, replaceGoogle }),
    }),

  /** The connected calendar (409 when none is connected). */
  calendarFeed: (cfg: Config, accountId?: string) => reqFeed(cfg, "/v1/calendar/feed" + accountQuery(accountId)),

  setCalendarVisibility: (cfg: Config, accountId: string, visible: boolean) =>
    req<CalendarStatus>(cfg, "/v1/calendar/visibility", { method: "POST", body: JSON.stringify({ accountId, visible }) }),

  /** The Google page to send the browser to for "Sign in with Google". */
  startGoogleSignIn: (cfg: Config, returnUrl: string) =>
    req<{ url: string }>(cfg, "/v1/google/start", {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    }),

  classroomStatus: (cfg: Config) => req<ClassroomStatus>(cfg, "/v1/classroom", { cache: "no-store" }),

  startClassroomSignIn: (cfg: Config, returnUrl: string) =>
    req<{ url: string }>(cfg, "/v1/classroom/start", {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    }),

  classroomFeed: async (cfg: Config, accountId?: string): Promise<ClassroomFeed> => {
    const feed: unknown = await req(cfg, "/v1/classroom/feed" + accountQuery(accountId), { cache: "no-store" });
    if (!isClassroomFeed(feed)) throw new Error("The Classroom assignment list couldn't be read. Existing reminders were kept.");
    if (accountId !== undefined && feed.accountId !== accountId) throw new Error("Classroom returned a different account. Existing assignments were kept.");
    return feed;
  },

  disconnectClassroom: (cfg: Config, accountId?: string) =>
    req<ClassroomDisconnectResult>(cfg, "/v1/classroom/disconnect", { method: "POST", body: JSON.stringify({ accountId }) }),

  disconnectCalendar: (cfg: Config, accountId?: string) =>
    req<CalendarStatus>(cfg, "/v1/calendar/disconnect", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    }),
};
