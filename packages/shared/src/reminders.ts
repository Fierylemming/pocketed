// Reminder scheduling + calendar helpers shared by the phone app (notifications)
// and both UIs (labels, monthly calendar, colour filtering).

import {
  DEFAULT_REMINDER_COLOR,
  itemTitle,
  normalizeReminderColor,
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

/** A reminder's colour as an exact shade (a retired name reads as its Google equivalent). */
export function effectiveReminderColor(note: Note): ReminderColorId {
  return normalizeReminderColor(note.color) ?? DEFAULT_REMINDER_COLOR;
}

/** Filters active reminders (items with a scheduled reminderAt) by colour. */
export function filterRemindersByColor(
  notes: Note[],
  colorFilter: ReminderColorId | "all",
): Note[] {
  // Both sides read as exact shades, so a filter set before the palette changed
  // (e.g. "sky") still finds the reminders coloured with it.
  const wanted =
    colorFilter === "all" ? "all" : (normalizeReminderColor(colorFilter) ?? colorFilter);
  return notes
    .filter(
      (n) =>
        !n.deleted &&
        typeof n.reminderAt === "number" &&
        n.reminderAt !== null &&
        (wanted === "all" || effectiveReminderColor(n) === wanted),
    )
    .sort((a, b) => (a.reminderAt as number) - (b.reminderAt as number));
}

// ---- Events that last a while (multi-day calendar events) ----

/** The reminder's end (exclusive), when its event lasts beyond its start; else null. */
export function reminderEnd(note: Note): number | null {
  if (typeof note.reminderAt !== "number" || typeof note.endAt !== "number") return null;
  return note.endAt > note.reminderAt ? note.endAt : null;
}

/** Local calendar days from the day of `start` to the day of `end`, inclusive (DST-safe). */
function daysBetween(start: number, end: number): number {
  const a = new Date(start);
  const b = new Date(end);
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  );
}

/**
 * How many calendar days an event from `start` to `end` (exclusive) touches:
 * 1 for anything that starts and ends on the same day. An event ending exactly
 * at midnight doesn't count the day it ends on.
 */
export function spanDayCount(start: number, end: number | null): number {
  if (end == null || end <= start) return 1;
  return daysBetween(start, end - 1) + 1;
}

/** True when the reminder's event runs across more than one calendar day. */
export function isMultiDay(note: Note): boolean {
  const end = reminderEnd(note);
  return end != null && spanDayCount(note.reminderAt as number, end) > 1;
}

export interface ReminderSpan {
  start: number;
  /** Exclusive; null for a reminder that is a moment in time. */
  end: number | null;
}

/**
 * Every occurrence of a reminder that is *on* at some point in [from, to):
 * like occurrencesBetween, but an occurrence that started before `from` and
 * is still running counts too. Each repeat lasts as long as the first.
 */
export function occurrenceSpansBetween(
  note: Note,
  from: number,
  to: number,
  cap = 500,
): ReminderSpan[] {
  if (typeof note.reminderAt !== "number") return [];
  const end0 = reminderEnd(note);
  const length = end0 == null ? 0 : end0 - note.reminderAt;
  const out: ReminderSpan[] = [];
  let at: number = note.reminderAt;
  const repeat = note.repeat ?? "none";
  for (let i = 0; i < MAX_STEPS && at < to && out.length < cap; i++) {
    if (at >= from || (length > 0 && at + length > from)) {
      out.push({ start: at, end: length > 0 ? at + length : null });
    }
    if (repeat === "none") break;
    const step = stepRepeat(at, repeat);
    if (step <= at) break;
    at = step;
  }
  return out;
}

/** Whether the reminder is on at some point during the local day `dateKey` ("YYYY-MM-DD"). */
export function reminderCoversDay(note: Note, dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number);
  const from = new Date(y!, m! - 1, d!).getTime();
  const to = new Date(y!, m! - 1, d! + 1).getTime();
  return occurrenceSpansBetween(note, from, to, 1).length > 0;
}

/** "Mon 12 Oct" */
function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Label for an event running across several days, e.g.
 * "Mon 12 Oct – Fri 16 Oct · 5 days" (all-day) or
 * "Fri 16 Oct 22:00 – Sat 17 Oct 02:00", plus "day 3 of 5" while it's on.
 * Null when the reminder isn't a multi-day event.
 */
export function formatSpanLabel(note: Note, now: number): string | null {
  const start = note.reminderAt;
  const end = reminderEnd(note);
  if (start == null || end == null) return null;
  const days = spanDayCount(start, end);
  if (days < 2) return null;
  const range = note.allDay
    ? `${shortDate(start)} – ${shortDate(end - 1)} · ${days} days`
    : `${shortDate(start)} ${hhmm(start)} – ${shortDate(end)} ${hhmm(end)}`;
  if (now >= start && now < end) {
    const day = Math.min(days, daysBetween(start, now) + 1);
    return `${range} · now, day ${day} of ${days}`;
  }
  return range;
}

export interface CalendarEntry {
  /** The reminder; for a repeat, a copy carrying this occurrence's times. */
  note: Note;
  start: number;
  /** Exclusive; null for a moment in time. */
  end: number | null;
  /** Runs across more than one calendar day. */
  multiDay: boolean;
  /** Which day of the event this cell shows (0 = first), and how many days it has. */
  dayIndex: number;
  dayCount: number;
  /** The event carries on from the day before / into the next day. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CalendarDay {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  /** Everything on this day (multi-day events on each day they cover), in time order. */
  reminders: Note[];
  entries: CalendarEntry[];
  /**
   * The same entries laid out in rows ("lanes") for drawing: a multi-day event
   * keeps one lane across its days within a week, so it can be drawn as one
   * continuous bar. Null = an empty lane kept so the lanes below line up.
   */
  slots: (CalendarEntry | null)[];
}

/**
 * Builds a 42-cell (6-week, Sun-Sat) calendar grid for the given year & month (0-indexed),
 * populated with active reminders (optionally filtered by colour). Events
 * that run across several days appear on every day they cover.
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
  const dayStarts: number[] = [];
  for (let i = 0; i <= 42; i++) {
    dayStarts.push(new Date(year, month, 1 - startOffset + i).getTime());
  }
  const gridFrom = dayStarts[0]!;
  const gridTo = dayStarts[42]!;
  const indexOfDay = (ts: number) => {
    // Last cell whose midnight is at or before ts.
    let lo = 0;
    let hi = 41;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dayStarts[mid]! <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Each occurrence is placed on every cell it covers. Repeating reminders
  // appear on every day they fall due in this grid.
  const entries: CalendarEntry[][] = Array.from({ length: 42 }, () => []);
  const multi: Array<{ first: number; last: number; cells: CalendarEntry[] }> = [];
  for (const r of filtered) {
    for (const span of occurrenceSpansBetween(r, gridFrom, gridTo)) {
      const dayCount = spanDayCount(span.start, span.end);
      const note =
        span.start === r.reminderAt
          ? r
          : { ...r, reminderAt: span.start, endAt: span.end ?? r.endAt ?? null };
      const firstCell = span.start < gridFrom ? 0 : indexOfDay(span.start);
      const lastTs = span.end == null ? span.start : span.end - 1;
      const lastCell = lastTs >= gridTo ? 41 : indexOfDay(lastTs);
      // Day of the event shown in the first visible cell.
      const offset = span.start < gridFrom ? daysBetween(span.start, gridFrom) : 0;
      const cells: CalendarEntry[] = [];
      for (let c = firstCell; c <= lastCell; c++) {
        const dayIndex = offset + (c - firstCell);
        const entry: CalendarEntry = {
          note,
          start: span.start,
          end: span.end,
          multiDay: dayCount > 1,
          dayIndex,
          dayCount,
          continuesBefore: dayIndex > 0,
          continuesAfter: dayIndex < dayCount - 1,
        };
        entries[c]!.push(entry);
        cells.push(entry);
      }
      if (dayCount > 1) multi.push({ first: firstCell, last: lastCell, cells });
    }
  }

  // Lanes, one week row at a time: multi-day events first (earliest, then
  // longest), each in the lowest lane free on all its days; then the day's
  // other reminders fill the gaps in time order.
  const slots: (CalendarEntry | null)[][] = Array.from({ length: 42 }, () => []);
  for (let w = 0; w < 6; w++) {
    const lo = w * 7;
    const hi = lo + 6;
    const inWeek = multi
      .filter((m) => m.first <= hi && m.last >= lo)
      .map((m) => ({ ...m, a: Math.max(m.first, lo), b: Math.min(m.last, hi) }))
      .sort(
        (x, y) =>
          x.a - y.a ||
          y.b - y.a - (x.b - x.a) ||
          x.cells[0]!.start - y.cells[0]!.start ||
          x.cells[0]!.note.id.localeCompare(y.cells[0]!.note.id),
      );
    for (const m of inWeek) {
      let lane = 0;
      while (true) {
        let free = true;
        for (let c = m.a; c <= m.b && free; c++) if (slots[c]![lane]) free = false;
        if (free) break;
        lane++;
      }
      for (let c = m.a; c <= m.b; c++) {
        const row = slots[c]!;
        while (row.length < lane) row.push(null);
        row[lane] = m.cells[c - m.first]!;
      }
    }
  }
  for (let c = 0; c < 42; c++) {
    const row = slots[c]!;
    const singles = entries[c]!.filter((e) => !e.multiDay).sort((x, y) => x.start - y.start);
    let lane = 0;
    for (const e of singles) {
      while (row[lane]) lane++;
      row[lane] = e;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
  }

  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(dayStarts[i]!);
    const dateKey = localDateKey(d.getTime());
    // Stable sort: reminders at the same time keep their usual order.
    const list = [...entries[i]!].sort((x, y) => x.start - y.start);
    days.push({
      dateKey,
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      isCurrentMonth: d.getMonth() === month && d.getFullYear() === year,
      isToday: dateKey === todayKey,
      reminders: list.map((e) => e.note),
      entries: list,
      slots: slots[i]!,
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

// ---- Early alerts ("30 min before") ----

export interface EarlyAlert {
  note: Note;
  /** When the early alert fires (epoch ms). */
  at: number;
  /** Minutes before the reminder time. */
  minutes: number;
}

/** The time a note's early alert fires, or null when it has none. */
export function earlyAlertAt(note: Note): number | null {
  if (typeof note.reminderAt !== "number") return null;
  const m = note.alertBefore;
  if (typeof m !== "number" || !(m > 0)) return null;
  return note.reminderAt - m * 60_000;
}

/** Early alerts that fell due inside the half-open window (from, to]. */
export function earlyAlertsDueBetween(notes: Note[], from: number, to: number): EarlyAlert[] {
  const out: EarlyAlert[] = [];
  for (const n of notes) {
    if (n.deleted) continue;
    const at = earlyAlertAt(n);
    if (at != null && at > from && at <= to) {
      out.push({ note: n, at, minutes: n.alertBefore as number });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** "30 min", "1 hr", "1 hr 30 min", "2 days" — for alert labels. */
export function formatLeadTime(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? "1 day" : `${d} days`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** e.g. "Alerts 30 min before and at the start" (empty when there's no early alert). */
export function alertSummary(note: Note): string {
  if (earlyAlertAt(note) == null) return "";
  return `Alerts ${formatLeadTime(note.alertBefore as number)} before and at the start`;
}
