// "Sign in with Google" import (Option B): turns Google Calendar API events
// into the same CalendarEvent list the iCal importer produces, plus each
// event's exact Google colour (the iCal feed carries no colours at all).
//
// Event keys deliberately match the iCal importer's — the iCalUID for one-off
// events, `${iCalUID}@${originalStart}` for an occurrence of a repeating event —
// so switching between the two sources updates reminders instead of
// duplicating them.

import { ALL_DAY_HOUR, cleanDescription, cleanLine, zonedToEpoch } from "./calendar-util";
import type { CalendarEvent } from "./calendar";
import { LIMITS, truncate, type HexColor } from "./protocol";

/** Google event colours by API colorId, as shown in Google Calendar today. */
export const GOOGLE_EVENT_COLOR_IDS: Readonly<Record<string, HexColor>> = {
  "1": "#7986cb", // Lavender
  "2": "#33b679", // Sage
  "3": "#8e24aa", // Grape
  "4": "#e67c73", // Flamingo
  "5": "#f6bf26", // Banana
  "6": "#f4511e", // Tangerine
  "7": "#039be5", // Peacock
  "8": "#616161", // Graphite
  "9": "#3f51b5", // Blueberry
  "10": "#0b8043", // Basil
  "11": "#d50000", // Tomato
};

/**
 * Google calendar colours by API colorId. The API still reports the old
 * ("classic") shade as backgroundColor; Google Calendar shows the modern one.
 */
export const GOOGLE_CALENDAR_COLOR_IDS: Readonly<Record<string, { classic: string; modern: HexColor }>> = {
  "1": { classic: "#ac725e", modern: "#795548" }, // Cocoa
  "2": { classic: "#d06b64", modern: "#e67c73" }, // Flamingo
  "3": { classic: "#f83a22", modern: "#d50000" }, // Tomato
  "4": { classic: "#fa573c", modern: "#f4511e" }, // Tangerine
  "5": { classic: "#ff7537", modern: "#ef6c00" }, // Pumpkin
  "6": { classic: "#ffad46", modern: "#f09300" }, // Mango
  "7": { classic: "#42d692", modern: "#009688" }, // Eucalyptus
  "8": { classic: "#16a765", modern: "#0b8043" }, // Basil
  "9": { classic: "#7bd148", modern: "#7cb342" }, // Pistachio
  "10": { classic: "#b3dc6c", modern: "#c0ca33" }, // Avocado
  "11": { classic: "#fbe983", modern: "#e4c441" }, // Citron
  "12": { classic: "#fad165", modern: "#f6bf26" }, // Banana
  "13": { classic: "#92e1c0", modern: "#33b679" }, // Sage
  "14": { classic: "#9fe1e7", modern: "#039be5" }, // Peacock
  "15": { classic: "#9fc6e7", modern: "#4285f4" }, // Cobalt
  "16": { classic: "#4986e7", modern: "#3f51b5" }, // Blueberry
  "17": { classic: "#9a9cff", modern: "#7986cb" }, // Lavender
  "18": { classic: "#b99aff", modern: "#b39ddb" }, // Wisteria
  "19": { classic: "#c2c2c2", modern: "#616161" }, // Graphite
  "20": { classic: "#cabdbf", modern: "#a79b8e" }, // Birch
  "21": { classic: "#cca6ac", modern: "#ad1457" }, // Radicchio
  "22": { classic: "#f691b2", modern: "#d81b60" }, // Cherry Blossom
  "23": { classic: "#cd74e6", modern: "#8e24aa" }, // Grape
  "24": { classic: "#a47ae2", modern: "#9e69af" }, // Amethyst
};

export interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** The subset of a Google Calendar API Event resource that Pocketed reads. */
export interface GoogleEvent {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  originalStartTime?: GoogleEventTime;
  recurringEventId?: string;
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** What the server's calendar feed returns when signed in with Google. */
export interface GoogleFeed {
  source: "google";
  calendar: { colorId?: string; backgroundColor?: string };
  events: GoogleEvent[];
}

export function isGoogleFeed(x: unknown): x is GoogleFeed {
  const f = x as GoogleFeed;
  return !!f && typeof f === "object" && f.source === "google" && Array.isArray(f.events);
}

const HEX = /^#[0-9a-f]{6}$/;

/** The calendar's colour as Google Calendar shows it. */
export function googleCalendarColor(cal: GoogleFeed["calendar"] | null | undefined): HexColor | null {
  if (!cal) return null;
  const bg = typeof cal.backgroundColor === "string" ? cal.backgroundColor.toLowerCase() : "";
  const known = cal.colorId ? GOOGLE_CALENDAR_COLOR_IDS[cal.colorId] : undefined;
  // A palette colour (reported in its classic shade) -> the modern shade.
  if (known && (!bg || bg === known.classic)) return known.modern;
  const byClassic = Object.values(GOOGLE_CALENDAR_COLOR_IDS).find((c) => c.classic === bg);
  if (byClassic) return byClassic.modern;
  // A custom colour picked in Google Calendar is used exactly.
  return HEX.test(bg) ? (bg as HexColor) : null;
}

/** An event's own colour, else its calendar's. */
export function googleEventColor(ev: GoogleEvent, calendarColor: HexColor | null): HexColor | null {
  return (ev.colorId && GOOGLE_EVENT_COLOR_IDS[ev.colorId]) || calendarColor;
}

/** Events that shouldn't become reminders. */
export function skipGoogleEvent(ev: GoogleEvent): boolean {
  if (ev.status === "cancelled") return true;
  // "Working from home/office" markers aren't appointments.
  if (ev.eventType === "workingLocation") return true;
  // Invitations you said no to.
  if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) return true;
  return false;
}

function parseDate(s: string | undefined): { y: number; mo: number; d: number } | null {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

/** dateTime -> instant; date -> `hour` o'clock that day in `timeZone`. */
function toEpoch(t: GoogleEventTime | undefined, timeZone: string, hour: number): number | null {
  if (!t) return null;
  if (t.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  const d = parseDate(t.date);
  return d ? zonedToEpoch({ ...d, h: hour, mi: 0, s: 0 }, timeZone) : null;
}

export interface GoogleConvertOptions {
  /** Keep events that haven't ended by this time… */
  from: number;
  /** …and that start before this time. */
  to: number;
  /** The device's IANA zone (for all-day events). */
  timeZone: string;
  maxEvents?: number;
}

export function googleFeedToCalendarEvents(
  feed: GoogleFeed,
  opts: GoogleConvertOptions,
): CalendarEvent[] {
  const calColor = googleCalendarColor(feed.calendar);
  const out: CalendarEvent[] = [];
  for (const ev of feed.events) {
    if (!ev || typeof ev !== "object" || skipGoogleEvent(ev)) continue;
    const uid = ev.iCalUID || ev.id;
    if (!uid || !ev.start) continue;

    const allDay = !ev.start.dateTime && !!ev.start.date;
    const start = toEpoch(ev.start, opts.timeZone, allDay ? ALL_DAY_HOUR : 0);
    if (start == null) continue;
    let end: number;
    if (allDay) {
      // The end date of an all-day event is exclusive (the day after).
      const s = parseDate(ev.start.date)!;
      const e = parseDate(ev.end?.date);
      const valid = e && (e.y * 10000 + e.mo * 100 + e.d) > (s.y * 10000 + s.mo * 100 + s.d);
      end = zonedToEpoch(
        valid ? { ...e!, h: 0, mi: 0, s: 0 } : { ...s, d: s.d + 1, h: 0, mi: 0, s: 0 },
        opts.timeZone,
      );
    } else {
      end = toEpoch(ev.end, opts.timeZone, 0) ?? start;
      if (end < start) end = start;
    }
    if (end <= opts.from || start >= opts.to) continue;

    let key = uid;
    if (ev.recurringEventId && ev.originalStartTime) {
      const orig = toEpoch(ev.originalStartTime, opts.timeZone, 0);
      if (orig != null) key = `${uid}@${orig}`;
    }

    out.push({
      key,
      title: cleanLine(ev.summary ?? "") || "(No title)",
      description: cleanDescription(ev.description ?? ""),
      location: truncate(cleanLine(ev.location ?? ""), LIMITS.locationChars),
      start,
      end,
      allDay,
      color: googleEventColor(ev, calColor),
    });
  }
  out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  return out.slice(0, opts.maxEvents ?? 500);
}
