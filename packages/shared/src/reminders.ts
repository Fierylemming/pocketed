// Reminder scheduling + calendar helpers shared by the phone app (notifications)
// and both UIs (labels, monthly calendar, colour filtering).

import {
  DEFAULT_REMINDER_COLOR,
  itemTitle,
  REPEAT_OPTIONS,
  type Note,
  type RepeatId,
  type ReminderColorId,
} from "./protocol";

/** Stable Android-safe notification id for a (note, time) pair. */
export function notificationIdFor(noteId: string, reminderAt: number): number {
  const s = noteId + ":" + reminderAt;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 2147483646) + 1;
}

export function roundToMinute(ms: number): number {
  return Math.round(ms / 60000) * 60000;
}

/** Notes whose reminder is still ahead (or due within the grace window). */
export function schedulableReminders(
  notes: Note[],
  now: number,
  graceMs = 60_000,
): Note[] {
  return notes.filter(
    (n) =>
      !n.deleted &&
      typeof n.reminderAt === "number" &&
      n.reminderAt !== null &&
      n.reminderAt >= now - graceMs,
  );
}

export function overdueReminders(notes: Note[], now: number): Note[] {
  return notes.filter(
    (n) =>
      !n.deleted &&
      typeof n.reminderAt === "number" &&
      n.reminderAt !== null &&
      n.reminderAt < now,
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatReminderLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const hm =
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0");
  const day = new Date(now);
  const sameDay = d.toDateString() === day.toDateString();
  const tomorrow = new Date(now + 86_400_000);
  if (sameDay) return `Today ${hm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${hm}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${hm}`;
}

export interface ReminderPlan {
  toSchedule: { id: number; noteId: string; at: number; title: string }[];
  toCancel: number[];
}

/** Diff what should be scheduled against what currently is. */
export function reminderDiff(
  notes: Note[],
  currentIds: number[],
  now: number,
): ReminderPlan {
  const wanted = schedulableReminders(notes, now).map((n) => ({
    id: notificationIdFor(n.id, n.reminderAt as number),
    noteId: n.id,
    at: n.reminderAt as number,
    title: itemTitle(n) || "Reminder",
  }));
  const wantedIds = new Set(wanted.map((w) => w.id));
  return {
    toSchedule: wanted,
    toCancel: currentIds.filter((id) => !wantedIds.has(id)),
  };
}

/** Notes whose reminder fell due inside the half-open window (from, to]. */
export function remindersDueBetween(notes: Note[], from: number, to: number): Note[] {
  return notes.filter(
    (n) =>
      !n.deleted &&
      typeof n.reminderAt === "number" &&
      n.reminderAt > from &&
      n.reminderAt <= to,
  );
}

export interface QuickReminder {
  id: string;
  label: string;
  at: number;
}

/** Quick-pick reminder times. Every `at` is strictly in the future. */
export function quickReminders(now: number): QuickReminder[] {
  const tomorrowNine = new Date(now);
  tomorrowNine.setDate(tomorrowNine.getDate() + 1);
  tomorrowNine.setHours(9, 0, 0, 0);
  return [
    { id: "15m", label: "In 15 minutes", at: roundToMinute(now + 15 * 60_000) },
    { id: "1h", label: "In 1 hour", at: roundToMinute(now + 60 * 60_000) },
    { id: "3h", label: "In 3 hours", at: roundToMinute(now + 3 * 60 * 60_000) },
    { id: "tomorrow", label: "Tomorrow 9:00", at: tomorrowNine.getTime() },
  ];
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Formats a timestamp for an <input type="datetime-local">, in local time. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parses a datetime-local value (local time). Returns null when invalid. */
export function fromLocalInput(value: string): number | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const [y, mo, da, h, mi] = m.slice(1).map(Number);
  const d = new Date(y, mo - 1, da, h, mi, 0, 0);
  // reject overflowed values such as 2026-02-31
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  if (d.getHours() !== h || d.getMinutes() !== mi) return null;
  return d.getTime();
}

/** Returns "YYYY-MM-DD" in local time for grouping reminders by calendar day. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function effectiveReminderColor(note: Note): ReminderColorId {
  return note.color ?? DEFAULT_REMINDER_COLOR;
}

/** Filters active reminders (items with a scheduled reminderAt) by colour. */
export function filterRemindersByColor(
  notes: Note[],
  colorFilter: ReminderColorId | "all",
): Note[] {
  return notes
    .filter(
      (n) =>
        !n.deleted &&
        typeof n.reminderAt === "number" &&
        n.reminderAt !== null &&
        (colorFilter === "all" || effectiveReminderColor(n) === colorFilter),
    )
    .sort((a, b) => (a.reminderAt as number) - (b.reminderAt as number));
}

export interface CalendarDay {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  reminders: Note[];
}

/**
 * Builds a 42-cell (6-week, Sun-Sat) calendar grid for the given year & month (0-indexed),
 * populated with active reminders (optionally filtered by colour).
 */
export function buildCalendarMonth(
  year: number,
  month: number,
  notes: Note[],
  now: number,
  colorFilter: ReminderColorId | "all" = "all",
): CalendarDay[] {
  const filtered = filterRemindersByColor(notes, colorFilter);
  const todayKey = localDateKey(now);
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0 (Sun) .. 6 (Sat)
  const gridStart = new Date(year, month, 1 - startOffset);
  const gridEnd = new Date(year, month, 1 - startOffset + 42);

  // Repeating reminders appear on every day they fall due in this grid.
  // Each occurrence is a copy of the note with its own reminderAt.
  const byDay = new Map<string, Note[]>();
  for (const r of filtered) {
    for (const at of occurrencesBetween(r, gridStart.getTime(), gridEnd.getTime())) {
      const key = localDateKey(at);
      const list = byDay.get(key) ?? [];
      list.push(at === r.reminderAt ? r : { ...r, reminderAt: at });
      byDay.set(key, list);
    }
  }

  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    const dateKey = localDateKey(d.getTime());
    days.push({
      dateKey,
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      isCurrentMonth: d.getMonth() === month && d.getFullYear() === year,
      isToday: dateKey === todayKey,
      reminders: byDay.get(dateKey) ?? [],
    });
  }
  return days;
}

// ---- Repeating reminders ----

const MAX_STEPS = 5000;

/** Moves `at` forward by one repeat step, in local time (keeps the wall-clock time across DST). */
export function stepRepeat(at: number, repeat: RepeatId): number {
  const d = new Date(at);
  switch (repeat) {
    case "daily":
      d.setDate(d.getDate() + 1);
      break;
    case "weekdays":
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "biweekly":
      d.setDate(d.getDate() + 14);
      break;
    case "monthly": {
      // Keep the day-of-month; clamp to the last day for short months (31st -> 30th/28th).
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      break;
    }
    case "yearly": {
      const day = d.getDate();
      const month = d.getMonth();
      d.setDate(1);
      d.setFullYear(d.getFullYear() + 1);
      d.setMonth(month);
      const lastDay = new Date(d.getFullYear(), month + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      break;
    }
    default:
      return at;
  }
  return d.getTime();
}

/**
 * The first occurrence strictly after `after`, starting from the series anchor
 * `at`. Returns null for one-off reminders (repeat "none"/missing).
 */
export function nextOccurrence(
  at: number,
  repeat: RepeatId | null | undefined,
  after: number,
): number | null {
  if (!repeat || repeat === "none") return null;
  let next = at;
  for (let i = 0; i < MAX_STEPS && next <= after; i++) {
    const step = stepRepeat(next, repeat);
    if (step <= next) break; // defensive: never loop on a stuck clock
    next = step;
  }
  return next;
}

/**
 * Marks the current occurrence done. Repeating reminders roll forward to their
 * next time (strictly after `now`); one-off reminders clear. Used by the
 * "Done" button and when a repeating alert fires.
 */
export function reminderAfterDone(
  reminderAt: number | null,
  repeat: RepeatId | null | undefined,
  now: number,
): number | null {
  if (reminderAt == null) return null;
  return nextOccurrence(reminderAt, repeat, Math.max(now, reminderAt));
}

/**
 * Every time a reminder fires within the half-open window [from, to), starting
 * from its stored (next pending) time. One-off reminders yield at most one.
 */
export function occurrencesBetween(
  note: Note,
  from: number,
  to: number,
  cap = 500,
): number[] {
  if (typeof note.reminderAt !== "number") return [];
  const out: number[] = [];
  let at: number = note.reminderAt;
  const repeat = note.repeat ?? "none";
  for (let i = 0; i < MAX_STEPS && at < to && out.length < cap; i++) {
    if (at >= from) out.push(at);
    if (repeat === "none") break;
    const step = stepRepeat(at, repeat);
    if (step <= at) break;
    at = step;
  }
  return out;
}

/** Human label for a repeating reminder, e.g. "Every week" (empty when it doesn't repeat). */
export function repeatSummary(repeat: RepeatId | null | undefined): string {
  if (!repeat || repeat === "none") return "";
  return REPEAT_OPTIONS.find((o) => o.id === repeat)?.label ?? "";
}
