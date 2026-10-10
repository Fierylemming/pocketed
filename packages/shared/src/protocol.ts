// Core types + pure helpers shared by the web app, the phone app and the server.

export const LIMITS = {
  noteTextChars: 4000,
  noteTitleChars: 200,
  noteBodyChars: 50_000,
  reminderBodyChars: 500,
  locationChars: 200,
  sectionNameChars: 100,
  maxImagesPerNote: 8,
  maxImageDataUrlChars: 800_000,
  opsPerPush: 500,
  opsPerPull: 1000,
} as const;

export type ItemKind = "note" | "reminder";

export type ReminderColorId =
  | "ruby"
  | "amber"
  | "emerald"
  | "sky"
  | "violet"
  | "rose";

export interface ReminderColorDef {
  id: ReminderColorId;
  label: string;
  hex: string;
  bg: string;
  border: string;
}

/** Diverse but limited set of colours for colour-coding reminders on the calendar. */
export const REMINDER_COLORS: readonly ReminderColorDef[] = [
  {
    id: "ruby",
    label: "Ruby",
    hex: "#ff6b6b",
    bg: "rgba(255, 107, 107, 0.16)",
    border: "#ff6b6b",
  },
  {
    id: "amber",
    label: "Amber",
    hex: "#ffd166",
    bg: "rgba(255, 209, 102, 0.16)",
    border: "#ffd166",
  },
  {
    id: "emerald",
    label: "Emerald",
    hex: "#06d6a0",
    bg: "rgba(6, 214, 160, 0.16)",
    border: "#06d6a0",
  },
  {
    id: "sky",
    label: "Sky",
    hex: "#4ea8de",
    bg: "rgba(78, 168, 222, 0.16)",
    border: "#4ea8de",
  },
  {
    id: "violet",
    label: "Violet",
    hex: "#a855f7",
    bg: "rgba(168, 85, 247, 0.16)",
    border: "#a855f7",
  },
  {
    id: "rose",
    label: "Rose",
    hex: "#f472b6",
    bg: "rgba(244, 114, 182, 0.16)",
    border: "#f472b6",
  },
] as const;

export const DEFAULT_REMINDER_COLOR: ReminderColorId = "amber";

export function isValidReminderColor(c: unknown): c is ReminderColorId {
  return typeof c === "string" && REMINDER_COLORS.some((rc) => rc.id === c);
}

export function getReminderColor(color?: ReminderColorId | null): ReminderColorDef {
  return REMINDER_COLORS.find((c) => c.id === color) ?? REMINDER_COLORS[1];
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Section {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface Note {
  id: string;
  text: string;
  /** Distinguishes a large Note from a small Reminder. */
  kind?: ItemKind;
  /** Explicit title for the note or reminder. */
  title?: string;
  /** Body text (short for reminders, large for notes). */
  body?: string;
  /** Section folder ID this item belongs to, or null for general/home. */
  sectionId?: string | null;
  /** Location string for reminders (set from the location tab). */
  location?: string | null;
  /** Colour code for reminders. */
  color?: ReminderColorId | null;
  /** Uploaded images (data URLs) for notes. */
  images?: string[];
  /** Interactive checklist items for notes. */
  checklist?: ChecklistItem[];
  /** Whether a note is pinned to the top of its section. */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of a scheduled reminder, or null when the note has none. */
  reminderAt: number | null;
  deleted: boolean;
}

export type OpKind = "upsert" | "delete" | "section-upsert" | "section-delete";

/** A single change. `id` is a client-generated idempotency key. */
export interface Op {
  id: string;
  kind: OpKind;
  noteId: string;
  text?: string;
  itemKind?: ItemKind;
  title?: string;
  body?: string;
  sectionId?: string | null;
  location?: string | null;
  color?: ReminderColorId | null;
  images?: string[];
  checklist?: ChecklistItem[];
  pinned?: boolean;
  sectionName?: string;
  reminderAt?: number | null;
  createdAt?: number;
  /** Last-writer-wins timestamp. */
  updatedAt: number;
}

export function uid(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

export function noteTitle(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length ? line : "(empty note)";
}

export function itemTitle(note: Note): string {
  if (typeof note.title === "string" && note.title.trim().length > 0) {
    return note.title.trim();
  }
  return noteTitle(note.text);
}

export function itemBody(note: Note): string {
  if (typeof note.body === "string") {
    return note.body;
  }
  const lines = note.text.split("\n");
  return lines.length > 1 ? lines.slice(1).join("\n").trim() : "";
}

export function isReminderItem(note: Note): boolean {
  if (note.kind === "reminder") return true;
  if (note.kind === "note") return false;
  return typeof note.reminderAt === "number" && note.reminderAt !== null;
}

export function composeNoteText(title: string, body: string): string {
  const t = title.trim();
  const b = body.trim();
  const combined = b ? `${t}\n${b}` : t;
  return truncate(combined, LIMITS.noteTextChars);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Pinned first (for notes), then newest first; stable tie-break so every device shows the same order. */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  });
}

export function sortSections(sections: Section[]): Section[] {
  return [...sections].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

export function validateOp(op: Op): string | null {
  if (!op || typeof op.id !== "string" || !op.id) return "op.id missing";
  if (
    op.kind !== "upsert" &&
    op.kind !== "delete" &&
    op.kind !== "section-upsert" &&
    op.kind !== "section-delete"
  ) {
    return "op.kind invalid";
  }
  if (typeof op.noteId !== "string" || !op.noteId) return "op.noteId missing";
  if (typeof op.updatedAt !== "number") return "op.updatedAt missing";
  if (op.kind === "upsert") {
    if (typeof op.text !== "string") return "op.text missing";
    if (op.text.length > LIMITS.noteTextChars) return "op.text too long";
    if (
      op.title !== undefined &&
      (typeof op.title !== "string" || op.title.length > LIMITS.noteTitleChars)
    ) {
      return "op.title too long";
    }
    if (
      op.body !== undefined &&
      (typeof op.body !== "string" || op.body.length > LIMITS.noteBodyChars)
    ) {
      return "op.body too long";
    }
    if (
      op.location != null &&
      (typeof op.location !== "string" || op.location.length > LIMITS.locationChars)
    ) {
      return "op.location too long";
    }
    if (op.color != null && !isValidReminderColor(op.color)) {
      return "op.color invalid";
    }
    if (op.images !== undefined) {
      if (!Array.isArray(op.images) || op.images.length > LIMITS.maxImagesPerNote) {
        return "op.images invalid";
      }
      for (const img of op.images) {
        if (typeof img !== "string" || img.length > LIMITS.maxImageDataUrlChars) {
          return "op.images item invalid";
        }
      }
    }
  }
  if (op.kind === "section-upsert") {
    if (typeof op.sectionName !== "string" || !op.sectionName.trim()) {
      return "op.sectionName missing";
    }
    if (op.sectionName.length > LIMITS.sectionNameChars) {
      return "op.sectionName too long";
    }
  }
  return null;
}
