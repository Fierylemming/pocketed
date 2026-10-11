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
  /** Longest "alert me N minutes before" lead time: one week. */
  alertBeforeMinutes: 7 * 24 * 60,
  sourceRefChars: 200,
} as const;

/** Where an item came from. Missing/null = made by hand in Pocketed. */
export type ItemSource = "gcal";

export function isValidSource(s: unknown): s is ItemSource {
  return s === "gcal";
}

/** Imported calendar events alert this many minutes before they start (and again at the start). */
export const CALENDAR_ALERT_BEFORE_MINUTES = 30;
/** Imported calendar events use this colour. */
export const CALENDAR_REMINDER_COLOR: ReminderColorId = "sky";

export type ItemKind = "note" | "reminder";

/** A colour copied exactly from elsewhere (Google Calendar), as lowercase "#rrggbb". */
export type HexColor = `#${string}`;

/**
 * A reminder's colour: one of Pocketed's six named colours, or an exact hex
 * colour (imported events keep their Google Calendar colour).
 */
export type ReminderColorId = PaletteColorId | HexColor;

export type PaletteColorId =
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

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isHexColor(c: unknown): c is HexColor {
  return typeof c === "string" && HEX_RE.test(c);
}

export function isValidReminderColor(c: unknown): c is ReminderColorId {
  return typeof c === "string" && (REMINDER_COLORS.some((rc) => rc.id === c) || HEX_RE.test(c));
}

/**
 * Google Calendar's colours as shown in its (modern) interface, by name. The
 * API reports event colours by id ("1"-"11") and calendar colours in the
 * classic palette, so both are translated to these exact values.
 */
export const GOOGLE_COLORS: readonly { name: string; hex: HexColor }[] = [
  { name: "Tomato", hex: "#d50000" },
  { name: "Flamingo", hex: "#e67c73" },
  { name: "Tangerine", hex: "#f4511e" },
  { name: "Banana", hex: "#f6bf26" },
  { name: "Sage", hex: "#33b679" },
  { name: "Basil", hex: "#0b8043" },
  { name: "Peacock", hex: "#039be5" },
  { name: "Blueberry", hex: "#3f51b5" },
  { name: "Lavender", hex: "#7986cb" },
  { name: "Grape", hex: "#8e24aa" },
  { name: "Graphite", hex: "#616161" },
  // calendar-only colours
  { name: "Radicchio", hex: "#ad1457" },
  { name: "Cherry Blossom", hex: "#d81b60" },
  { name: "Pumpkin", hex: "#ef6c00" },
  { name: "Mango", hex: "#f09300" },
  { name: "Citron", hex: "#e4c441" },
  { name: "Avocado", hex: "#c0ca33" },
  { name: "Pistachio", hex: "#7cb342" },
  { name: "Eucalyptus", hex: "#009688" },
  { name: "Cobalt", hex: "#4285f4" },
  { name: "Wisteria", hex: "#b39ddb" },
  { name: "Amethyst", hex: "#9e69af" },
  { name: "Cocoa", hex: "#795548" },
  { name: "Birch", hex: "#a79b8e" },
];

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Display info for any reminder colour (named or exact hex). */
export function getReminderColor(color?: ReminderColorId | null): ReminderColorDef {
  if (isHexColor(color)) {
    const named = GOOGLE_COLORS.find((g) => g.hex === color);
    return {
      id: color,
      label: named?.name ?? "Custom",
      hex: color,
      bg: hexToRgba(color, 0.16),
      border: color,
    };
  }
  return REMINDER_COLORS.find((c) => c.id === color) ?? REMINDER_COLORS[1];
}

/** How a reminder repeats after its time. "none" = one-off. */
export type RepeatId =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";

export const REPEAT_OPTIONS: readonly { id: RepeatId; label: string; short: string }[] = [
  { id: "none", label: "Does not repeat", short: "" },
  { id: "daily", label: "Every day", short: "Daily" },
  { id: "weekdays", label: "Every weekday (Mon–Fri)", short: "Weekdays" },
  { id: "weekly", label: "Every week", short: "Weekly" },
  { id: "biweekly", label: "Every 2 weeks", short: "Every 2 weeks" },
  { id: "monthly", label: "Every month", short: "Monthly" },
  { id: "yearly", label: "Every year", short: "Yearly" },
] as const;

export function isValidRepeat(r: unknown): r is RepeatId {
  return typeof r === "string" && REPEAT_OPTIONS.some((o) => o.id === r);
}

export function repeatLabel(r?: RepeatId | null): string {
  return REPEAT_OPTIONS.find((o) => o.id === r)?.short ?? "";
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
  /** How the reminder repeats (only meaningful when reminderAt is set). */
  repeat?: RepeatId | null;
  /** Extra early alert, in minutes before reminderAt (the main alert still fires at reminderAt). */
  alertBefore?: number | null;
  /** Set when the item was imported (e.g. from Google Calendar) rather than typed in. */
  source?: ItemSource | null;
  /** Importer bookkeeping: which version of the source event this was made from. */
  sourceRef?: string | null;
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
  repeat?: RepeatId | null;
  alertBefore?: number | null;
  source?: ItemSource | null;
  sourceRef?: string | null;
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
    if (op.repeat != null && !isValidRepeat(op.repeat)) {
      return "op.repeat invalid";
    }
    if (
      op.alertBefore != null &&
      (typeof op.alertBefore !== "number" ||
        !Number.isInteger(op.alertBefore) ||
        op.alertBefore <= 0 ||
        op.alertBefore > LIMITS.alertBeforeMinutes)
    ) {
      return "op.alertBefore invalid";
    }
    if (op.source != null && !isValidSource(op.source)) {
      return "op.source invalid";
    }
    if (
      op.sourceRef != null &&
      (typeof op.sourceRef !== "string" || op.sourceRef.length > LIMITS.sourceRefChars)
    ) {
      return "op.sourceRef invalid";
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
