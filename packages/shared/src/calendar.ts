// Calendar import: keeps one reminder per upcoming calendar event.
//
// Source-agnostic: the web app feeds it events parsed from the Google Calendar
// secret iCal address (Option A, no colours) or fetched with "Sign in with
// Google" (Option B, see google-calendar.ts, which also supplies colours).
//
// Rules:
//  - timed events alert CALENDAR_ALERT_BEFORE_MINUTES before and at the start;
//    all-day events alert once (their start is already 9:00 on the day)
//  - an event changed in the calendar updates its reminder; your own section
//    and pin are kept. The colour follows Google when Google supplies one,
//    otherwise your own choice is kept
//  - ✅ or deleting an imported reminder sticks, unless the event later moves
//    to a new time
//  - a cancelled or deleted event (which the calendar reports as such) removes
//    its reminder straight away
//  - a reminder whose event has *started* and is no longer in the calendar
//    (over, or moved out of the window) is removed — but only when the check
//    can see the whole calendar; a reminder for an event still to come is never
//    removed just because it wasn't in the feed. A calendar check that can't
//    see an event may add or update, never delete: absence from a feed that
//    might be incomplete or truncated is not evidence that an event is gone.

import {
  CALENDAR_ALERT_BEFORE_MINUTES,
  CALENDAR_REMINDER_COLOR,
  composeNoteText,
  LIMITS,
  truncate,
  type HexColor,
  type Note,
} from "./protocol";
import { deleteNote, putItem, updateItem, type SyncState } from "./sync";

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
  /** Exact colour from Google Calendar, when known (not in iCal feeds). */
  color?: HexColor | null;
}

export interface CalendarImportResult {
  state: SyncState;
  added: number;
  updated: number;
  removed: number;
  /** Reminders a previous check removed in bulk that this check found again. */
  restored: number;
  /** Reminders left alone because the check couldn't vouch for the whole calendar. */
  kept: number;
}

export interface ReconcileOptions {
  /**
   * Allow removals for reminders whose event has *started* and is missing from
   * `events` (default true). Pass false when the feed may be incomplete — an
   * empty or truncated list — so that a check can never take reminders away.
   */
  sweep?: boolean;
  /** Event keys the calendar itself reported as cancelled or deleted. */
  cancelledKeys?: readonly string[];
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
    JSON.stringify([ev.title, ev.description, ev.location, ev.end, ev.allDay, ev.color ?? null]),
  )}`;
}

function refStart(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const n = Number(ref.split(":")[0]);
  return Number.isFinite(n) ? n : null;
}

/** The event's end as stored on its reminder: null when it has no length. */
export function calendarEventEnd(ev: CalendarEvent): number | null {
  return ev.end > ev.start ? ev.end : null;
}

/**
 * Reminders imported before events' end times were kept have no all-day flag
 * (null/missing). The next check fills both in once — just those two fields,
 * so anything you changed on the reminder yourself stays as it is.
 */
function needsEventTimes(n: Note): boolean {
  return !n.deleted && n.reminderAt != null && n.allDay == null;
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
    // Kept so the calendar can show events that run across several days.
    endAt: calendarEventEnd(ev),
    allDay: ev.allDay,
    repeat: "none" as const,
    alertBefore: ev.allDay ? null : CALENDAR_ALERT_BEFORE_MINUTES,
    source: "gcal" as const,
    sourceRef: calendarSourceRef(ev),
    sectionId: prev?.sectionId ?? null,
    color: ev.color ?? prev?.color ?? CALENDAR_REMINDER_COLOR,
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
  opts: ReconcileOptions = {},
): CalendarImportResult {
  let s = state;
  let added = 0;
  let updated = 0;
  let removed = 0;
  let restored = 0;
  let kept = 0;
  const seen = new Set<string>();
  const swept = sweptInBulk(s);

  // Cancelled or deleted events: the calendar said so, so their reminders go
  // now — no waiting for the event's time to pass.
  for (const key of opts.cancelledKeys ?? []) {
    const id = calendarNoteId(key);
    if (s.notes[id] && !s.notes[id].deleted) {
      s = deleteNote(s, id, now);
      removed++;
    }
  }

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
    // A reminder removed together with others is one a previous check took
    // away, not one you dismissed. (A sweep leaves the event's own details
    // untouched, so this is checked before "unchanged" below.)
    const sweptAway = prev.deleted && swept.has(prev.updatedAt);
    if (prev.sourceRef === ref && !sweptAway) {
      if (needsEventTimes(prev)) {
        s = updateItem(
          s,
          id,
          {
            // A reminder you moved to another time keeps being a moment.
            endAt: prev.reminderAt === ev.start ? calendarEventEnd(ev) : null,
            allDay: ev.allDay,
          },
          now,
        );
        updated++;
      }
      continue; // unchanged (live or dismissed)
    }

    const live = !prev.deleted && prev.reminderAt != null;
    if (!live) {
      if (sweptAway) {
        // The calendar still has this event, so a check that took the reminder
        // away was wrong: put it back, keeping your own section and pin.
        s = putItem(s, id, calendarNoteFields(ev, prev), now);
        restored++;
        continue;
      }
      // Dismissed by hand: stays dismissed unless the event moved to a new time.
      if (refStart(prev.sourceRef) === ev.start) continue;
      s = putItem(s, id, calendarNoteFields(ev, null), now);
      added++;
      continue;
    }
    s = putItem(s, id, calendarNoteFields(ev, prev), now);
    updated++;
  }

  // An empty list is never a statement that the calendar is empty: it is a
  // failed or partial check, and it must not take reminders away.
  const maySweep = opts.sweep !== false && events.length > 0;
  for (const n of Object.values(s.notes)) {
    if (n.source !== "gcal" || n.deleted || seen.has(n.id)) continue;
    // Only an event that has already started can be known to be gone (it would
    // still be in the feed otherwise). Anything still to come stays put: the
    // feed may simply not have shown it.
    if (!maySweep || (refStart(n.sourceRef) ?? 0) > now) {
      kept++;
      continue;
    }
    s = deleteNote(s, n.id, now);
    removed++;
  }

  return { state: s, added, updated, removed, restored, kept };
}

/**
 * When a calendar check removes several imported reminders, it does so all at
 * once — the same instant on every device (the delete travels with its
 * timestamp). That is the signature of a check taking reminders away, and of
 * nothing a person does by hand. Deleting a section takes its reminders with it
 * in the same instant too, so those stamps are left out: that is a decision.
 */
function sweptInBulk(state: SyncState): Set<number> {
  const counts = new Map<number, number>();
  for (const n of Object.values(state.notes)) {
    if (n.deleted && n.source === "gcal") counts.set(n.updatedAt, (counts.get(n.updatedAt) ?? 0) + 1);
  }
  const bySection = new Set<number>();
  for (const sec of Object.values(state.sections ?? {})) {
    if (sec.deleted) bySection.add(sec.updatedAt);
  }
  const out = new Set<number>();
  for (const [at, count] of counts) {
    if (count >= 2 && !bySection.has(at)) out.add(at);
  }
  return out;
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
  return { state: s, added: 0, updated: 0, removed, restored: 0, kept: 0 };
}
