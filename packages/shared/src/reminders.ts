// Reminder scheduling helpers shared by the phone app (notifications)
// and both UIs (labels).

import type { Note } from "./protocol";

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
    title: n.text.split("\n")[0] || "Reminder",
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
