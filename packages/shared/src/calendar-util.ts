// Small helpers shared by the calendar importers (iCal feed and Google API):
// time-zone maths via Intl, and event text clean-up.

import { LIMITS, truncate } from "./protocol";

/** All-day events get their reminder at this local hour. */
export const ALL_DAY_HOUR = 9;

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

export interface WallTime {
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

export function cleanLine(s: string): string {
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
