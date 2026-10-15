import {
  effectiveReminderColor,
  formatLeadTime,
  formatReminderLabel,
  formatSpanLabel,
  getReminderColor,
  GOOGLE_COLORS,
  isReminderItem,
  normalizeReminderColor,
  REMINDER_COLORS,
  childSections,
  descendantSectionIds,
  flattenSectionTree,
  itemTitle,
  repeatLabel,
  sectionPathLabel,
  sortNotes,
  sortSections,
  visibleSections,
  type Note,
  type ReminderColorDef,
  type SectionTreeRow,
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

/* ---- Display ordering (a device preference; the stored order never changes) ---- */

export type SectionSortOrder = "added" | "name-asc" | "name-desc" | "newest-first";
export type NoteSortOrder =
  | "recently-edited"
  | "title-asc"
  | "title-desc"
  | "newest-first"
  | "oldest-first";

export const SECTION_SORT_OPTIONS: readonly { id: SectionSortOrder; label: string }[] = [
  { id: "added", label: "Date added" },
  { id: "name-asc", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "newest-first", label: "Newest first" },
];

export const NOTE_SORT_OPTIONS: readonly { id: NoteSortOrder; label: string }[] = [
  { id: "recently-edited", label: "Recently edited" },
  { id: "title-asc", label: "Title A–Z" },
  { id: "title-desc", label: "Title Z–A" },
  { id: "newest-first", label: "Newest first" },
  { id: "oldest-first", label: "Oldest first" },
];

export function isSectionSortOrder(value: unknown): value is SectionSortOrder {
  return SECTION_SORT_OPTIONS.some((o) => o.id === value);
}

export function isNoteSortOrder(value: unknown): value is NoteSortOrder {
  return NOTE_SORT_OPTIONS.some((o) => o.id === value);
}

/**
 * Natural, case-insensitive ordering: numbers inside a name compare by value,
 * so "Item 2" comes before "Item 10" (plain alphabetical order would not).
 */
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function stableId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

/** Sections in the chosen display order. "added" is the usual oldest-first order. */
export function sortSectionsByOrder(
  sections: readonly Section[],
  order: SectionSortOrder,
): Section[] {
  if (order === "added") return sortSections([...sections]);
  return [...sections].sort((a, b) => {
    if (order === "name-asc") return naturalCollator.compare(a.name, b.name) || stableId(a, b);
    if (order === "name-desc") return naturalCollator.compare(b.name, a.name) || stableId(a, b);
    return b.createdAt - a.createdAt || stableId(a, b);
  });
}

export function sortedChildSections(
  sections: readonly Section[],
  parentId: string | null,
  order: SectionSortOrder,
): Section[] {
  return sortSectionsByOrder(childSections(sections, parentId), order);
}

/** The section tree flattened depth-first, with every level in the chosen order. */
export function sortedSectionTree(
  sections: readonly Section[],
  order: SectionSortOrder,
): SectionTreeRow[] {
  if (order === "added") return flattenSectionTree(sections);
  const out: SectionTreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const section of sortedChildSections(sections, parentId, order)) {
      out.push({
        section,
        depth,
        childCount: childSections(sections, section.id).length,
      });
      walk(section.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Notes in the chosen display order. Pinned notes stay at the top in every
 * order — pinning is an explicit "keep this first" — and the default is the
 * usual pinned-then-recently-edited order.
 */
export function sortNotesByOrder(notes: readonly Note[], order: NoteSortOrder): Note[] {
  if (order === "recently-edited") return sortNotes([...notes]);
  return [...notes].sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    if (order === "title-asc") return naturalCollator.compare(itemTitle(a), itemTitle(b)) || stableId(a, b);
    if (order === "title-desc") return naturalCollator.compare(itemTitle(b), itemTitle(a)) || stableId(a, b);
    if (order === "newest-first") return b.createdAt - a.createdAt || stableId(a, b);
    return a.createdAt - b.createdAt || stableId(a, b);
  });
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
  noteOrder: NoteSortOrder = "recently-edited",
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
  const notes = sortNotesByOrder(inFolder.filter((n) => !isReminderItem(n)), noteOrder);
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

export interface FolderSummary extends SectionSummary {
  /** Subsections directly inside. */
  subsections: number;
  /** Due reminders in this section and every subsection nested inside it. */
  dueInside: number;
  /** Notes + reminders in this section and every subsection nested inside it. */
  itemsInside: number;
}

/** Counts for a section folder card / sidebar row, including what's nested inside it. */
export function folderSummary(
  allNotes: Note[],
  sections: Section[],
  sectionId: string,
  now: number,
): FolderSummary {
  const direct = sectionCounts(allNotes, sectionId, now);
  const inside = new Set([sectionId, ...descendantSectionIds(sections, sectionId)]);
  let dueInside = 0;
  let itemsInside = 0;
  for (const n of allNotes) {
    if (n.deleted || n.sectionId == null || !inside.has(n.sectionId)) continue;
    itemsInside += 1;
    if (isReminderItem(n) && n.reminderAt != null && n.reminderAt <= now) dueInside += 1;
  }
  return {
    ...direct,
    subsections: childSections(sections, sectionId).length,
    dueInside,
    itemsInside,
  };
}

/** Items in a section or anywhere inside its subsections (`null` = General only). */
export function itemsWithinSection(
  allNotes: Note[],
  sections: Section[],
  sectionId: string | null,
): Note[] {
  if (sectionId === null) return allNotes.filter((n) => (n.sectionId ?? null) === null);
  const inside = new Set([sectionId, ...descendantSectionIds(sections, sectionId)]);
  return allNotes.filter((n) => n.sectionId != null && inside.has(n.sectionId));
}

/**
 * Sections whose `name` is their full path ("Work › Projects"), for badges on
 * cards shown outside their own folder.
 */
export function sectionsWithPathNames(sections: Section[]): Section[] {
  return sections.map((s) => ({ ...s, name: sectionPathLabel(sections, s.id) || s.name }));
}

/** Reminder counts per colour (an exact shade), plus "all". */
export function reminderColorCounts(allNotes: Note[]): Record<string, number> {
  const counts: Record<string, number> = { all: 0 };
  for (const n of allNotes) {
    if (n.deleted || n.reminderAt == null) continue;
    counts.all += 1;
    const c = effectiveReminderColor(n);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

/**
 * Every colour your reminders actually use, in Google Calendar's palette order
 * with custom shades last. The calendar's colour filter lists these, so it only
 * offers colours you'd really see.
 */
export function colorsInUse(allNotes: Note[]): ReminderColorDef[] {
  const seen = new Set<string>();
  for (const n of allNotes) {
    if (n.deleted || n.reminderAt == null) continue;
    seen.add(effectiveReminderColor(n));
  }
  const order = (hex: string) => {
    const i = GOOGLE_COLORS.findIndex((g) => g.hex === hex);
    return i < 0 ? GOOGLE_COLORS.length : i;
  };
  return [...seen]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((hex) => getReminderColor(hex as ReminderColorId));
}

/**
 * Choices for a colour picker: Google Calendar's palette, with an item's own
 * shade (a Google custom colour, or one of the retired six) first so it stays
 * selectable.
 */
export function colorPickerChoices(
  current: ReminderColorId | null | undefined,
): readonly ReminderColorDef[] {
  const hex = normalizeReminderColor(current);
  if (!hex || REMINDER_COLORS.some((c) => c.id === hex)) return REMINDER_COLORS;
  return [getReminderColor(hex), ...REMINDER_COLORS];
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
  // Events running across several days show their whole range.
  const span = formatSpanLabel(note, now);
  const when = span ? "📅 " + span : "⏰ " + formatReminderLabel(note.reminderAt, now);
  return when + (rep ? ` · 🔁 ${rep}` : "") + early;
}
