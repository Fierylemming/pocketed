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
