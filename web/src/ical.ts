// Turns an iCalendar (.ics) feed into the upcoming event occurrences inside a
// time window. Repeating events are expanded (RRULE/RDATE/EXDATE) and moved or
// cancelled single occurrences (RECURRENCE-ID) are honoured, via ical.js.
//
// Google's secret feed holds a calendar's entire history (often megabytes),
// so two shortcuts keep this fast enough to run on a phone every few minutes:
//  1. a cheap text pre-filter drops events that are clearly over (or too far
//     ahead) before the expensive parse;
//  2. long-running daily/weekly repeats are "rebased" to start just before the
//     window instead of being stepped through from years ago.
//
// Loaded lazily (dynamic import) so the main app bundle doesn't carry ical.js.

import ICAL from "ical.js";
import { LIMITS, truncate, type CalendarEvent } from "@pocketed/shared";

export interface ExpandOptions {
  /** Keep occurrences that haven't ended by this time… */
  from: number;
  /** …and that start before this time. */
  to: number;
  /** IANA zone used for all-day and "floating" events (the device's zone). */
  timeZone: string;
  /** Hard cap on returned occurrences (earliest kept). */
  maxEvents?: number;
  /** Tests only: disable the speed shortcuts to get the reference result. */
  noShortcuts?: boolean;
}

/** All-day events get their reminder at this local hour. */
export const ALL_DAY_HOUR = 9;

const DAY = 86_400_000;
const MAX_STEPS_PER_SERIES = 20_000;

export class CalendarParseError extends Error {}

export function looksLikeCalendar(text: string): boolean {
  return /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 512));
}

type Comp = InstanceType<typeof ICAL.Component>;
type ITime = InstanceType<typeof ICAL.Time>;
type IEvent = InstanceType<typeof ICAL.Event>;

export function parseCalendar(text: string, opts: ExpandOptions): CalendarEvent[] {
  if (!looksLikeCalendar(text)) {
    throw new CalendarParseError("That link didn't return a calendar.");
  }
  let root: Comp;
  try {
    const input = opts.noShortcuts ? text : prefilter(text, opts);
    root = new ICAL.Component(ICAL.parse(input) as unknown[]);
  } catch {
    throw new CalendarParseError("The calendar couldn't be read.");
  }

  // Zone definitions in the feed: only a fallback for zone names the runtime's
  // Intl doesn't know (e.g. Windows names in Outlook feeds).
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      /* ignore malformed zone */
    }
  }
  const calZone = validZone(String(root.getFirstPropertyValue("x-wr-timezone") ?? ""));
  const zone = validZone(opts.timeZone) ?? calZone ?? "UTC";

  const masters = new Map<string, Comp>();
  const exceptions = new Map<string, Comp[]>();
  const orphans: Comp[] = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const uid = String(ve.getFirstPropertyValue("uid") ?? "");
    if (!ve.getFirstProperty("dtstart")) continue;
    if (ve.hasProperty("recurrence-id")) {
      if (!uid) continue;
      const list = exceptions.get(uid) ?? [];
      list.push(ve);
      exceptions.set(uid, list);
    } else if (uid) {
      masters.set(uid, ve);
    } else {
      orphans.push(ve);
    }
  }
  // An override whose series isn't in the feed is just a one-off event.
  for (const [uid, list] of exceptions) {
    if (!masters.has(uid)) orphans.push(...list);
  }

  const ctx: Ctx = { opts, floatingZone: zone, userZone: zone };
  const out: CalendarEvent[] = [];
  for (const [uid, ve] of masters) {
    try {
      expandSeries(uid, ve, exceptions.get(uid) ?? [], ctx, out);
    } catch {
      /* one broken event must not sink the whole calendar */
    }
  }
  orphans.forEach((ve, i) => {
    try {
      const uid = String(ve.getFirstPropertyValue("uid") ?? `orphan-${i}`);
      const ev = new ICAL.Event(ve);
      const rid = ve.getFirstPropertyValue("recurrence-id");
      const key = rid ? `${uid}@${String(rid)}` : uid;
      pushOccurrence(key, ev, ev.startDate, ev.endDate, ctx, out);
    } catch {
      /* skip */
    }
  });

  out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  return out.slice(0, opts.maxEvents ?? 500);
}

// ---- 1. cheap pre-filter on the raw text ----

/** UTC "YYYYMMDD" for comparisons against iCal date strings. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

function propDay(block: string, name: string): string | null {
  // DTSTART;TZID=Europe/London:20261012T100000 / DTSTART;VALUE=DATE:20261012
  const m = new RegExp(`(?:^|\\n)${name}(?:;[^:\\r\\n]*)?:(\\d{8})`, "i").exec(block);
  return m ? m[1] : null;
}

/**
 * Drops VEVENTs that certainly can't produce an occurrence in the window.
 * Conservative: anything unusual (no DTEND, DURATION, RDATE…) is kept and
 * judged properly by the full parse. Day keys carry a 2-day margin for zones.
 */
export function prefilter(text: string, opts: ExpandOptions): string {
  const w: Bounds = {
    lo: dayKey(opts.from - 2 * DAY),
    hi: dayKey(opts.to + 2 * DAY),
    hiMoved: dayKey(opts.to + 9 * DAY), // overrides may move an occurrence
    loLong: dayKey(opts.from - 31 * DAY), // events given a DURATION instead of an end
  };
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    const b = text.indexOf("BEGIN:VEVENT", pos);
    if (b === -1) {
      parts.push(text.slice(pos));
      break;
    }
    const e = text.indexOf("END:VEVENT", b);
    if (e === -1) {
      parts.push(text.slice(pos));
      break;
    }
    const end = e + "END:VEVENT".length;
    parts.push(text.slice(pos, b));
    const block = text.slice(b, end);
    if (keepBlock(block.replace(/\r?\n[ \t]/g, ""), w)) parts.push(block);
    pos = end;
  }
  return parts.join("");
}

interface Bounds {
  lo: string;
  hi: string;
  hiMoved: string;
  loLong: string;
}

function keepBlock(block: string, w: Bounds): boolean {
  const start = propDay(block, "DTSTART");
  if (!start) return true;
  if (/\n(RRULE|RDATE)[;:]/i.test(block)) {
    if (start > w.hi) return false;
    if (/\nRDATE[;:]/i.test(block)) return true;
    const until = /\nRRULE:[^\r\n]*UNTIL=(\d{8})/i.exec(block);
    return !until || until[1] >= w.lo;
  }
  if (/\nRECURRENCE-ID[;:]/i.test(block)) {
    const rid = propDay(block, "RECURRENCE-ID");
    const inWin = (d: string | null) => !!d && d >= w.lo && d <= w.hiMoved;
    return inWin(start) || inWin(rid);
  }
  if (start > w.hi) return false;
  if (/\nDURATION[;:]/i.test(block)) return start >= w.loLong;
  const end = propDay(block, "DTEND") ?? start;
  return end >= w.lo;
}

// ---- 2. expansion ----

interface Ctx {
  opts: ExpandOptions;
  floatingZone: string;
  userZone: string;
}

function expandSeries(uid: string, master: Comp, overrides: Comp[], ctx: Ctx, out: CalendarEvent[]): void {
  const event = new ICAL.Event(master);
  const overridden = new Map<number, Comp>();
  for (const ex of overrides) {
    event.relateException(ex);
    try {
      const rid = ex.getFirstPropertyValue("recurrence-id") as ITime | null;
      if (rid) overridden.set(toEpoch(rid, ex, ctx, "recurrence-id"), ex);
    } catch {
      /* ignore */
    }
  }

  if (!event.isRecurring()) {
    pushOccurrence(uid, event, event.startDate, event.endDate, ctx, out);
    return;
  }

  if (!ctx.opts.noShortcuts) {
    const rebasedFrom = rebase(event, master, ctx);
    if (rebasedFrom != null) {
      // Occurrences before the new start are never visited; an override can
      // still have moved one of them into the window.
      for (const [rid, ex] of overridden) {
        if (rid < rebasedFrom) {
          const exEv = new ICAL.Event(ex);
          pushOccurrence(`${uid}@${rid}`, exEv, exEv.startDate, exEv.endDate, ctx, out);
        }
      }
    }
  }

  // Stop a week past the window: overrides can move an occurrence a bit.
  const stopAt = ctx.opts.to + 7 * DAY;
  const it = event.iterator();
  for (let i = 0; i < MAX_STEPS_PER_SERIES; i++) {
    const next = it.next();
    if (!next) break;
    const originalStart = toEpoch(next, master, ctx);
    if (originalStart > stopAt) break;
    // Long before the window: skip the (costly) details unless an override moved it.
    if (
      !ctx.opts.noShortcuts &&
      originalStart < ctx.opts.from - 8 * DAY &&
      !overridden.has(originalStart)
    ) {
      continue;
    }
    const d = event.getOccurrenceDetails(next);
    pushOccurrence(`${uid}@${originalStart}`, d.item, d.startDate, d.endDate, ctx, out);
  }
}

/**
 * Moves the start of a long-running DAILY/WEEKLY series forward by a whole
 * number of repeat periods, to just before the window. Every occurrence after
 * the new start is unchanged (EXDATE/RECURRENCE-ID match by original time, so
 * they still apply). A rebased start that doesn't itself match the rule lies
 * before the window and is skipped. Series with COUNT, RDATE or several
 * RRULEs are left alone (they're short or unusual). Returns the new start
 * (epoch ms), or null when nothing changed.
 */
function rebase(event: IEvent, master: Comp, ctx: Ctx): number | null {
  const rrules = master.getAllProperties("rrule");
  if (rrules.length !== 1 || master.hasProperty("rdate")) return null;
  const rule = rrules[0].getFirstValue() as InstanceType<typeof ICAL.Recur>;
  if (!rule || rule.count) return null;
  const unit = rule.freq === "DAILY" ? 1 : rule.freq === "WEEKLY" ? 7 : 0;
  if (!unit) return null;
  const period = unit * Math.max(1, rule.interval || 1);
  const start = event.startDate;
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const target = ctx.opts.from - 10 * DAY;
  const days = Math.floor((target - startMs) / DAY / period) * period;
  if (days < period * 4) return null; // not worth it
  const s = start.clone();
  s.adjust(days, 0, 0, 0);
  const end = event.endDate ? event.endDate.clone() : null;
  if (end) end.adjust(days, 0, 0, 0);
  event.startDate = s;
  if (end && master.hasProperty("dtend")) event.endDate = end;
  return toEpoch(s, master, ctx);
}

function pushOccurrence(
  key: string,
  item: IEvent,
  startDate: ITime,
  endDate: ITime | null,
  ctx: Ctx,
  out: CalendarEvent[],
): void {
  const comp = item.component;
  const status = String(comp.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (status === "CANCELLED") return;

  const allDay = startDate.isDate;
  let start: number;
  let end: number;
  if (allDay) {
    start = zonedToEpoch(
      { y: startDate.year, mo: startDate.month, d: startDate.day, h: ALL_DAY_HOUR, mi: 0, s: 0 },
      ctx.userZone,
    );
    // DTEND of an all-day event is exclusive (the day after); default one day.
    const e = endDate && endDate.isDate && endDate.compare(startDate) > 0 ? endDate : null;
    end = e
      ? zonedToEpoch({ y: e.year, mo: e.month, d: e.day, h: 0, mi: 0, s: 0 }, ctx.userZone)
      : zonedToEpoch(
          { y: startDate.year, mo: startDate.month, d: startDate.day + 1, h: 0, mi: 0, s: 0 },
          ctx.userZone,
        );
  } else {
    start = toEpoch(startDate, comp, ctx);
    end = endDate ? toEpoch(endDate, comp, ctx, "dtend") : start;
    if (end < start) end = start;
  }

  if (end <= ctx.opts.from || start >= ctx.opts.to) return;
  // Zero-length events count as "on" until their start time passes.
  if (end === start && start <= ctx.opts.from) return;

  out.push({
    key,
    title: cleanLine(String(comp.getFirstPropertyValue("summary") ?? "")) || "(No title)",
    description: cleanDescription(String(comp.getFirstPropertyValue("description") ?? "")),
    location: truncate(
      cleanLine(String(comp.getFirstPropertyValue("location") ?? "")),
      LIMITS.locationChars,
    ),
    start,
    end,
    allDay,
  });
}

/**
 * Wall-clock ICAL.Time -> epoch ms. Uses the TZID from the property and the
 * runtime's Intl zone data, which handles daylight saving correctly.
 */
function toEpoch(
  t: ITime,
  comp: Comp,
  ctx: Ctx,
  prop: "dtstart" | "dtend" | "recurrence-id" = "dtstart",
): number {
  const parts = { y: t.year, mo: t.month, d: t.day, h: t.hour, mi: t.minute, s: t.second };
  const zone = t.zone;
  if (zone && (zone === ICAL.Timezone.utcTimezone || zone.tzid === "UTC" || zone.tzid === "Z")) {
    return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
  }
  const p = comp.getFirstProperty(prop) ?? comp.getFirstProperty("dtstart");
  const tzid = p?.getParameter("tzid");
  const tzName = typeof tzid === "string" ? tzid : Array.isArray(tzid) ? String(tzid[0]) : "";
  if (tzName) {
    const z = validZone(tzName) ?? validZone(tzName.replace(/^\/+/, ""));
    if (z) return zonedToEpoch(parts, z);
    // Unknown to Intl: fall back to the VTIMEZONE in the feed, if ical.js has it.
    if (zone && zone.tzid && zone.tzid !== "floating") return t.toUnixTime() * 1000;
  }
  return zonedToEpoch(parts, ctx.floatingZone);
}

// ---- time zones (Intl-based) ----

const zoneCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (zoneCache.has(zone)) return zoneCache.get(zone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    f = null;
  }
  zoneCache.set(zone, f);
  return f;
}

/** The zone name if the runtime knows it, else null. */
export function validZone(zone: string | null | undefined): string | null {
  if (!zone || typeof zone !== "string" || zone.length > 64) return null;
  return formatterFor(zone) ? zone : null;
}

/** zone offset (local - UTC) in ms at instant `ts`. */
function offsetAt(ts: number, zone: string): number {
  const f = formatterFor(zone);
  if (!f) return 0;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ts))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

interface WallTime {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Wall-clock time in `zone` -> epoch ms. Times skipped by DST move forward. */
export function zonedToEpoch(w: WallTime, zone: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const o1 = offsetAt(guess, zone);
  let ts = guess - o1;
  const o2 = offsetAt(ts, zone);
  if (o2 !== o1) ts = guess - o2;
  return ts;
}

// ---- text clean-up ----

function cleanLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Google descriptions can contain HTML; reduce to short plain text. */
export function cleanDescription(s: string): string {
  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(text, LIMITS.reminderBodyChars);
}
