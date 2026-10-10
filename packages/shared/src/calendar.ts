// Calendar import: keeps one reminder per upcoming calendar event.
//
// Source-agnostic: the web app feeds it events parsed from the Google Calendar
// secret iCal address (Option A); a future "Sign in with Google" importer
// (Option B) only has to produce the same CalendarEvent list.
//
// Rules:
//  - timed events alert CALENDAR_ALERT_BEFORE_MINUTES before and at the start;
//    all-day events alert once (their start is already 9:00 on the day)
//  - an event changed in the calendar updates its reminder; your own colour,
//    section and pin are kept
//  - ✅ or deleting an imported reminder sticks, unless the event later moves
//    to a new time
//  - an imported reminder whose event is no longer upcoming (ended, cancelled,
//    deleted, or outside the window) is removed

import {
  CALENDAR_ALERT_BEFORE_MINUTES,
  CALENDAR_REMINDER_COLOR,
  composeNoteText,
  LIMITS,
  truncate,
  type Note,
} from "./protocol";
import { deleteNote, putItem, type SyncState } from "./sync";

/** How far ahead events are imported. */
export const CALENDAR_WINDOW_DAYS = 60;
/** Hard cap on imported events (earliest kept). */
export const MAX_IMPORTED_EVENTS = 500;

export interface CalendarEvent {
  /** Stable per occurrence: the UID, plus the original start for repeats. */
  key: string;
  title: string;
  description: string;
  location: string;
  /** Epoch ms. All-day events: the local time their single alert fires (9:00). */
  start: number;
  /** Epoch ms. */
  end: number;
  allDay: boolean;
}

export interface CalendarImportResult {
  state: SyncState;
  added: number;
  updated: number;
  removed: number;
}

/** 64-bit FNV-1a style hash as 16 hex chars (sync, deterministic, not crypto). */
export function hash64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  return h1.toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Same event occurrence -> same note id, on every device. */
export function calendarNoteId(eventKey: string): string {
  return "gcal-" + hash64("gcal:" + eventKey) + hash64("salt:" + eventKey).slice(0, 8);
}

/** "<start>:<hash of the copied fields>" — what the reminder was made from. */
export function calendarSourceRef(ev: CalendarEvent): string {
  return `${ev.start}:${hash64(
    JSON.stringify([ev.title, ev.description, ev.location, ev.end, ev.allDay]),
  )}`;
}

function refStart(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const n = Number(ref.split(":")[0]);
  return Number.isFinite(n) ? n : null;
}

/** Note fields for an event, keeping the user's own choices from `prev`. */
export function calendarNoteFields(ev: CalendarEvent, prev: Note | null) {
  const title = truncate(ev.title || "(No title)", LIMITS.noteTitleChars);
  const body = truncate(ev.description, LIMITS.reminderBodyChars);
  return {
    text: composeNoteText(title, body),
    kind: "reminder" as const,
    title,
    body,
    location: ev.location ? truncate(ev.location, LIMITS.locationChars) : null,
    reminderAt: ev.start,
    repeat: "none" as const,
    alertBefore: ev.allDay ? null : CALENDAR_ALERT_BEFORE_MINUTES,
    source: "gcal" as const,
    sourceRef: calendarSourceRef(ev),
    sectionId: prev?.sectionId ?? null,
    color: prev?.color ?? CALENDAR_REMINDER_COLOR,
    images: prev?.images ?? [],
    checklist: prev?.checklist ?? [],
    pinned: prev?.pinned ?? false,
    createdAt: prev?.createdAt,
  };
}

/**
 * Brings the imported reminders in `state` in line with `events` (the full
 * list of upcoming events). Only changed items produce ops.
 */
export function reconcileCalendar(
  state: SyncState,
  events: CalendarEvent[],
  now: number,
): CalendarImportResult {
  let s = state;
  let added = 0;
  let updated = 0;
  let removed = 0;
  const seen = new Set<string>();

  for (const ev of events.slice(0, MAX_IMPORTED_EVENTS)) {
    const id = calendarNoteId(ev.key);
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = calendarSourceRef(ev);
    const prev = s.notes[id] ?? null;

    if (!prev) {
      s = putItem(s, id, calendarNoteFields(ev, null), now);
      added++;
      continue;
    }
    if (prev.sourceRef === ref) continue; // unchanged (whether live or dismissed)

    const live = !prev.deleted && prev.reminderAt != null;
    if (!live) {
      // Dismissed: stays dismissed unless the event moved to a new time.
      if (refStart(prev.sourceRef) === ev.start) continue;
      s = putItem(s, id, calendarNoteFields(ev, prev.deleted ? null : prev), now);
      added++;
      continue;
    }
    s = putItem(s, id, calendarNoteFields(ev, prev), now);
    updated++;
  }

  for (const n of Object.values(s.notes)) {
    if (n.source === "gcal" && !n.deleted && !seen.has(n.id)) {
      s = deleteNote(s, n.id, now);
      removed++;
    }
  }

  return { state: s, added, updated, removed };
}

/** Removes every live imported reminder (used when disconnecting). */
export function removeImportedReminders(state: SyncState, now: number): CalendarImportResult {
  let s = state;
  let removed = 0;
  for (const n of Object.values(s.notes)) {
    if (n.source === "gcal" && !n.deleted) {
      s = deleteNote(s, n.id, now);
      removed++;
    }
  }
  return { state: s, added: 0, updated: 0, removed };
}
