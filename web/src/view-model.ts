import { sortNotes, type Note } from "@pocketed/shared";
import { formatReminderLabel } from "@pocketed/shared";
import type { Phase, SyncManager } from "./store";

export function rowsFor(manager: SyncManager): Note[] {
  return sortNotes(Object.values(manager.state.notes).filter((n) => !n.deleted));
}

export interface Sections {
  /** Reminders whose time has passed, oldest first. */
  due: Note[];
  /** Reminders still ahead, soonest first. */
  upcoming: Note[];
  /** Everything without a reminder, newest first. */
  notes: Note[];
}

export function sectionsFor(notes: Note[], now: number): Sections {
  const live = notes.filter((n) => !n.deleted);
  const at = (n: Note) => n.reminderAt as number;
  const due = live
    .filter((n) => n.reminderAt != null && at(n) <= now)
    .sort((a, b) => at(a) - at(b));
  const upcoming = live
    .filter((n) => n.reminderAt != null && at(n) > now)
    .sort((a, b) => at(a) - at(b));
  const notesOnly = sortNotes(live.filter((n) => n.reminderAt == null));
  return { due, upcoming, notes: notesOnly };
}

/** Case-insensitive match against every line of the note. Blank query matches all. */
export function matchesQuery(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return note.text.toLowerCase().includes(q);
}

export function syncStatus(
  phase: Phase,
  lastSync: number | null,
  now: number,
  lastError: string | null,
): string {
  switch (phase) {
    case "syncing":
      return "Syncing…";
    case "offline":
      return "Offline — saved on this device";
    case "error":
      return lastError ?? "Can't reach server";
    case "synced": {
      if (lastSync == null) return "Synced";
      const s = Math.max(0, Math.floor((now - lastSync) / 1000));
      if (s < 45) return "Synced just now";
      const m = Math.floor(s / 60);
      if (m < 60) return `Synced ${m}m ago`;
      return `Synced ${Math.floor(m / 60)}h ago`;
    }
  }
}

export function reminderMeta(note: Note, now: number): string | null {
  if (note.reminderAt == null) return null;
  return "⏰ " + formatReminderLabel(note.reminderAt, now);
}
