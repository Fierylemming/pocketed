// Builds the payload the Android home-screen widget renders.

import type { Note } from "./protocol";
import { noteTitle, truncate } from "./protocol";
import { formatReminderLabel } from "./reminders";

export interface WidgetItem {
  id: string;
  title: string;
  meta: string;
  kind: "overdue" | "reminder" | "note";
}

export interface WidgetData {
  updatedAt: number;
  items: WidgetItem[];
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Order: overdue reminders, today's reminders, then newest notes. */
export function buildWidgetData(
  notes: Note[],
  now: number,
  max = 12,
): WidgetData {
  const live = notes.filter((n) => !n.deleted);
  const withReminder = live.filter(
    (n) => typeof n.reminderAt === "number" && n.reminderAt !== null,
  );
  const overdue = withReminder
    .filter((n) => (n.reminderAt as number) < now)
    .sort((a, b) => (a.reminderAt as number) - (b.reminderAt as number));
  const today = withReminder
    .filter(
      (n) =>
        (n.reminderAt as number) >= now &&
        (n.reminderAt as number) < startOfLocalDay(now) + 2 * 86_400_000 &&
        (n.reminderAt as number) < startOfLocalDay(now) + 86_400_000 + 86_400_000,
    )
    .sort((a, b) => (a.reminderAt as number) - (b.reminderAt as number));
  const rest = live
    .filter((n) => typeof n.reminderAt !== "number" || n.reminderAt === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const items: WidgetItem[] = [
    ...overdue.map((n) => ({
      id: n.id,
      title: truncate(noteTitle(n.text), 40),
      meta: "due " + formatReminderLabel(n.reminderAt as number, now),
      kind: "overdue" as const,
    })),
    ...today.map((n) => ({
      id: n.id,
      title: truncate(noteTitle(n.text), 40),
      meta: formatReminderLabel(n.reminderAt as number, now),
      kind: "reminder" as const,
    })),
    ...rest.map((n) => ({
      id: n.id,
      title: truncate(noteTitle(n.text), 40),
      meta: shortAgo(n.updatedAt, now),
      kind: "note" as const,
    })),
  ];
  return { updatedAt: now, items: items.slice(0, max) };
}

/** How many rows fit a widget of the given height (px). */
export function itemsForHeight(heightPx: number, row = 44, pad = 40): number {
  return Math.max(1, Math.floor((heightPx - pad) / row));
}

export function shortAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
