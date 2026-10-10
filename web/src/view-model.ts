import {
  effectiveReminderColor,
  formatLeadTime,
  formatReminderLabel,
  isReminderItem,
  REMINDER_COLORS,
  repeatLabel,
  sortNotes,
  visibleSections,
  type Note,
  type ReminderColorId,
  type Section,
} from "@pocketed/shared";
import type { Phase, SyncManager } from "./store";

export function rowsFor(manager: SyncManager): Note[] {
  return sortNotes(Object.values(manager.state.notes).filter((n) => !n.deleted));
}

export function userSectionsFor(manager: SyncManager): Section[] {
  return visibleSections(manager.state);
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

export interface FolderContents {
  reminders: Note[];
  notes: Note[];
}

/**
 * Splits items belonging to a specific section folder (`sectionId`, or `null` for general/unsectioned)
 * into Reminders and Notes.
 */
export function itemsInSection(
  allNotes: Note[],
  sectionId: string | null,
): FolderContents {
  const inFolder = allNotes.filter(
    (n) => !n.deleted && (n.sectionId ?? null) === sectionId,
  );
  const reminders = inFolder
    .filter((n) => isReminderItem(n))
    .sort((a, b) => {
      if (a.reminderAt != null && b.reminderAt != null) {
        return a.reminderAt - b.reminderAt;
      }
      if (a.reminderAt != null) return -1;
      if (b.reminderAt != null) return 1;
      return b.updatedAt - a.updatedAt;
    });
  const notes = sortNotes(inFolder.filter((n) => !isReminderItem(n)));
  return { reminders, notes };
}

export interface SectionSummary {
  notes: number;
  reminders: number;
  due: number;
}

export function sectionCounts(
  allNotes: Note[],
  sectionId: string | null,
  now: number,
): SectionSummary {
  const { reminders, notes } = itemsInSection(allNotes, sectionId);
  const due = reminders.filter(
    (r) => r.reminderAt != null && r.reminderAt <= now,
  ).length;
  return {
    notes: notes.length,
    reminders: reminders.length,
    due,
  };
}

export function reminderColorCounts(
  allNotes: Note[],
): Record<ReminderColorId | "all", number> {
  const counts: Record<ReminderColorId | "all", number> = {
    all: 0,
    ruby: 0,
    amber: 0,
    emerald: 0,
    sky: 0,
    violet: 0,
    rose: 0,
  };
  for (const n of allNotes) {
    if (n.deleted || n.reminderAt == null) continue;
    counts.all += 1;
    const c = effectiveReminderColor(n);
    if (REMINDER_COLORS.some((rc) => rc.id === c)) {
      counts[c] += 1;
    }
  }
  return counts;
}

/** Case-insensitive match against title, body, text, location, and checklist items. Blank query matches all. */
export function matchesQuery(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (note.text.toLowerCase().includes(q)) return true;
  if (note.title && note.title.toLowerCase().includes(q)) return true;
  if (note.body && note.body.toLowerCase().includes(q)) return true;
  if (note.location && note.location.toLowerCase().includes(q)) return true;
  if (
    note.checklist &&
    note.checklist.some((item) => item.text.toLowerCase().includes(q))
  ) {
    return true;
  }
  return false;
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
  const rep = repeatLabel(note.repeat);
  const early =
    typeof note.alertBefore === "number" && note.alertBefore > 0
      ? ` · 🔔 ${formatLeadTime(note.alertBefore)} before`
      : "";
  return "⏰ " + formatReminderLabel(note.reminderAt, now) + (rep ? ` · 🔁 ${rep}` : "") + early;
}
