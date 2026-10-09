import { sortNotes, type Note } from "@pocketed/shared";
import { formatReminderLabel } from "@pocketed/shared";
import type { Phase, SyncManager } from "./store";

export function rowsFor(manager: SyncManager): Note[] {
  return sortNotes(Object.values(manager.state.notes).filter((n) => !n.deleted));
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

export const REMINDER_CHOICES = [
  { id: "none", label: "No reminder" },
  { id: "1h", label: "In 1 hour" },
  { id: "tonight", label: "Today 21:00" },
  { id: "tomorrow", label: "Tomorrow 9:00" },
] as const;

export function reminderAtFor(choice: string, now: number): number | null {
  if (choice === "1h") return round(now + 3_600_000);
  if (choice === "tonight") return atLocal(now, 21, 0);
  if (choice === "tomorrow") return atLocal(now + 86_400_000, 9, 0);
  return null;
}

function round(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

function atLocal(ms: number, h: number, m: number): number {
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
