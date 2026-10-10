// Google Calendar link (Option A: the calendar's "secret address in iCal format").
//
// The Worker only keeps the link and passes the feed through to the apps;
// the apps parse it and create/update reminders through the normal op log.
// Parsing happens on the device because a calendar's full history can be
// megabytes, far beyond the Workers free plan's 10 ms CPU budget, while
// streaming the response through costs the Worker almost nothing.

import { truncate } from "@pocketed/shared";
import type { Store } from "./store";

const FETCH_TIMEOUT_MS = 20_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface CalendarStatus {
  connected: boolean;
  /** Safe-to-show description of the link, never the secret itself. */
  feed: string | null;
  connectedAt: number | null;
}

export class CalendarInputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Accepts https:// and webcal:// links; returns a fetchable https URL or null. */
export function normalizeFeedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 2000) return null;
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/** "calendar.google.com · …/basic.ics" — enough to recognise, useless to steal. */
export function feedHint(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return last ? `${u.hostname} · …/${truncate(last, 40)}` : u.hostname;
  } catch {
    return "calendar link";
  }
}

export async function calendarStatus(store: Store): Promise<CalendarStatus> {
  const cfg = await store.getCalendar();
  return {
    connected: cfg !== null,
    feed: cfg ? feedHint(cfg.url) : null,
    connectedAt: cfg?.connectedAt ?? null,
  };
}

/** Fetches the feed; throws CalendarInputError with a message fit for the user. */
async function fetchUpstream(url: string, fetcher: Fetcher): Promise<Response> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new CalendarInputError("Couldn't reach the calendar. Try again in a minute.", 502);
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    throw new CalendarInputError(
      "Google didn't accept that link — it may have been reset. Copy the secret address again.",
      502,
    );
  }
  if (!res.ok) {
    throw new CalendarInputError(`The calendar server answered with an error (${res.status}).`, 502);
  }
  return res;
}

/** Reads just the start of a body (cheap) to check it's a calendar. */
async function startsLikeCalendar(res: Response): Promise<boolean> {
  if (!res.body) return false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let head = "";
  try {
    while (head.length < 512) {
      const { value, done } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(head);
}

/** Checks the link once, then saves it. */
export async function connectCalendar(
  store: Store,
  rawUrl: unknown,
  now: number,
  fetcher: Fetcher,
): Promise<void> {
  const url = normalizeFeedUrl(rawUrl);
  if (!url) {
    throw new CalendarInputError(
      "Paste the full link — it starts with https://calendar.google.com/…",
    );
  }
  const res = await fetchUpstream(url, fetcher);
  if (!(await startsLikeCalendar(res))) {
    throw new CalendarInputError(
      'That link didn\'t return a calendar. Use the "Secret address in iCal format" from Google Calendar\'s settings.',
    );
  }
  await store.setCalendar({ url, connectedAt: now });
}

/** Streams the connected feed to the app without reading it. */
export async function proxyFeed(
  store: Store,
  fetcher: Fetcher,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const cfg = await store.getCalendar();
  if (!cfg) throw new CalendarInputError("No calendar connected.", 409);
  const res = await fetchUpstream(cfg.url, fetcher);
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
