// "Sign in with Google" import (Option B): turns Google Calendar API events
// into the same CalendarEvent list the iCal importer produces, plus each
// event's exact Google colour (the iCal feed carries no colours at all).
//
// An event's colour reaches the API in two ways: the legacy `colorId` (the 11
// colours events had before June 2026, reported in the old "classic" shades) or
// an `eventLabelId` pointing at a label on the event's own calendar, which is
// how the 24 default colours and any custom shade arrive. Labels win, because
// they carry the shade Google Calendar itself shows.
//
// Primary-calendar keys deliberately match the iCal importer's — the iCalUID for one-off
// events, `${iCalUID}@${originalStart}` for an occurrence of a repeating event —
// so switching between the two sources updates reminders instead of
// duplicating them. Other calendars namespace keys by calendar ID, so copies
// of an event on different calendars never overwrite each other.

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
  /** Added by Pocketed when relaying events from multiple calendars. */
  calendarId?: string;
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  /**
   * The event's colour as one of the calendar's labels (Google's "custom event
   * colours", June 2026 onwards). Looked up in the calendar's `eventLabels`.
   */
  eventLabelId?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  originalStartTime?: GoogleEventTime;
  recurringEventId?: string;
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** One of a calendar's event colours ("labels"), referred to by id. */
export interface GoogleEventLabel {
  /** UUID. Events point at it with `eventLabelId`. */
  id: string;
  /** The colour Google Calendar shows, as "#rrggbb". */
  backgroundColor: string;
  /** The name the user gave the label, if any. */
  name?: string;
}

/** Calendar-list metadata used to identify each event's source and colour. */
export interface GoogleCalendar {
  id: string;
  primary?: boolean;
  colorId?: string;
  backgroundColor?: string;
  /**
   * The calendar's own event colours. Since June 2026 an event can wear any of
   * Google's 24 colours (or one of up to 200 custom shades), and the API
   * reports those only as a label id — the colour lives here, on the calendar
   * resource, not in the calendar list.
   */
  eventLabels?: GoogleEventLabel[];
}

/** What the server's calendar feed returns when signed in with Google. */
export interface GoogleFeed {
  source: "google";
  /** Primary colour, retained for clients/servers using the single-calendar feed. */
  calendar: { colorId?: string; backgroundColor?: string };
  calendars?: GoogleCalendar[];
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

/** A calendar's event labels by id, ready to resolve an event's `eventLabelId`. */
export function googleEventLabels(cal: GoogleCalendar | null | undefined): Map<string, HexColor> {
  const out = new Map<string, HexColor>();
  for (const label of cal?.eventLabels ?? []) {
    const bg = typeof label?.backgroundColor === "string" ? label.backgroundColor.toLowerCase() : "";
    if (label?.id && HEX.test(bg)) out.set(label.id, bg as HexColor);
  }
  return out;
}

/**
 * An event's own colour: its label, else its (legacy) colour id, else its
 * calendar's. A label carries exactly the shade Google Calendar shows — one of
 * the 24 default colours or a custom one — so it wins. Events coloured from the
 * old 11-colour palette carry a label too, but the id is kept as a fallback for
 * calendars whose labels couldn't be read.
 */
export function googleEventColor(
  ev: GoogleEvent,
  calendarColor: HexColor | null,
  labels?: ReadonlyMap<string, HexColor> | null,
): HexColor | null {
  const labelled = ev.eventLabelId ? labels?.get(ev.eventLabelId) : undefined;
  return labelled || (ev.colorId && GOOGLE_EVENT_COLOR_IDS[ev.colorId]) || calendarColor;
}

/**
 * Events the calendar should never be asked about: "working from home/office"
 * markers (not appointments) and invitations you said no to. Unlike a cancelled
 * event, these are not news — they are simply not imported, so an unrecognised
 * one changes nothing.
 */
export function skipGoogleEventForever(ev: GoogleEvent): boolean {
  if (ev.eventType === "workingLocation") return true;
  if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) return true;
  return false;
}

/** Events that shouldn't become reminders: those, plus the cancelled/deleted ones. */
export function skipGoogleEvent(ev: GoogleEvent): boolean {
  return ev.status === "cancelled" || skipGoogleEventForever(ev);
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
  /**
   * Keep events that haven't ended by this time… Optional: the server has
   * already cut the feed to the upcoming window with *its* clock, so the app
   * deliberately leaves these unset — a phone with a wrong clock must not be
   * able to empty the calendar, and an empty event list means a failed check
   * (which must never remove reminders).
   */
  from?: number;
  /** …and that start before this time. Optional, as above. */
  to?: number;
  /** The device's IANA zone (for all-day events). */
  timeZone: string;
  maxEvents?: number;
}

/**
 * The key that identifies one occurrence of an event, the same on every device
 * and the same for the iCal feed: the iCalUID, plus the original start for one
 * occurrence of a repeating event. Other calendars namespace by calendar id, so
 * copies of an event on two calendars stay separate.
 */
function googleEventKey(
  ev: GoogleEvent,
  calendars: ReadonlyMap<string, GoogleCalendar>,
  opts: GoogleConvertOptions,
): string | null {
  const uid = ev.iCalUID || ev.id;
  if (!uid) return null;
  let key = uid;
  if (ev.recurringEventId && ev.originalStartTime) {
    const orig = toEpoch(ev.originalStartTime, opts.timeZone, 0);
    if (orig != null) key = `${uid}@${orig}`;
  }
  if (ev.calendarId && !calendars.get(ev.calendarId)?.primary) {
    key = `google:${JSON.stringify([ev.calendarId, key])}`;
  }
  return key;
}

/**
 * The events Google reports as cancelled or deleted (the feed asks for them
 * explicitly). Their reminders are removed on the calendar's word rather than
 * by guessing from an event's absence, which is what makes a check safe to run
 * when the feed might be incomplete.
 */
export function googleCancelledKeys(feed: GoogleFeed, opts: GoogleConvertOptions): string[] {
  const calendars = new Map((feed.calendars ?? []).map((cal) => [cal.id, cal]));
  const out = new Set<string>();
  for (const ev of feed.events ?? []) {
    if (!ev || typeof ev !== "object" || ev.status !== "cancelled") continue;
    if (skipGoogleEventForever(ev)) continue;
    const key = googleEventKey(ev, calendars, opts);
    if (key) out.add(key);
  }
  return [...out];
}

export function googleFeedToCalendarEvents(
  feed: GoogleFeed,
  opts: GoogleConvertOptions,
): CalendarEvent[] {
  const calColor = googleCalendarColor(feed.calendar);
  const calendars = new Map((feed.calendars ?? []).map((cal) => [cal.id, cal]));
  // Labels are per calendar: the same id on two calendars is a different colour.
  const labelMaps = new Map<string, Map<string, HexColor>>();
  const labelsFor = (calendarId: string | undefined): Map<string, HexColor> | null => {
    if (!calendarId) return null;
    let m = labelMaps.get(calendarId);
    if (!m) {
      m = googleEventLabels(calendars.get(calendarId));
      labelMaps.set(calendarId, m);
    }
    return m;
  };
  const out: CalendarEvent[] = [];
  for (const ev of feed.events) {
    if (!ev || typeof ev !== "object" || skipGoogleEvent(ev)) continue;
    if (!ev.start) continue;

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
    const from = opts.from ?? 0;
    const to = opts.to ?? Number.MAX_SAFE_INTEGER;
    if (end <= from || start >= to) continue;

    const key = googleEventKey(ev, calendars, opts);
    if (!key) continue;

    out.push({
      key,
      title: cleanLine(ev.summary ?? "") || "(No title)",
      description: cleanDescription(ev.description ?? ""),
      location: truncate(cleanLine(ev.location ?? ""), LIMITS.locationChars),
      start,
      end,
      allDay,
      color: googleEventColor(
        ev,
        ev.calendarId && calendars.get(ev.calendarId)
          ? googleCalendarColor(calendars.get(ev.calendarId))
          : calColor,
        ev.eventLabelId ? labelsFor(ev.calendarId) : null,
      ),
    });
  }
  out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  return out.slice(0, opts.maxEvents ?? 500);
}
