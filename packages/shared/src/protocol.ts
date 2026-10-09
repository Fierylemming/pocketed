// Core types + pure helpers shared by the web app, the phone app and the server.

export const LIMITS = {
  noteTextChars: 4000,
  opsPerPush: 500,
  opsPerPull: 1000,
} as const;

export interface Note {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of a scheduled reminder, or null when the note has none. */
  reminderAt: number | null;
  deleted: boolean;
}

export type OpKind = "upsert" | "delete";

/** A single change. `id` is a client-generated idempotency key. */
export interface Op {
  id: string;
  kind: OpKind;
  noteId: string;
  text?: string;
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

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Newest first; stable tie-break so every device shows the same order. */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

export function validateOp(op: Op): string | null {
  if (!op || typeof op.id !== "string" || !op.id) return "op.id missing";
  if (op.kind !== "upsert" && op.kind !== "delete") return "op.kind invalid";
  if (typeof op.noteId !== "string" || !op.noteId) return "op.noteId missing";
  if (typeof op.updatedAt !== "number") return "op.updatedAt missing";
  if (op.kind === "upsert") {
    if (typeof op.text !== "string") return "op.text missing";
    if (op.text.length > LIMITS.noteTextChars) return "op.text too long";
  }
  return null;
}
