// The offline-first sync engine. Pure functions over a plain state object so
// the same code runs in the browser, on the phone and in tests.

import type { Note, Op } from "./protocol";
import { uid } from "./protocol";

export interface SyncState {
  notes: Record<string, Note>;
  /** Ops not yet accepted by the server. */
  outbox: Op[];
  /** Last server sequence number we have seen. */
  cursor: number;
}

export const emptyState = (): SyncState => ({ notes: {}, outbox: [], cursor: 0 });

/** Append an op, collapsing any older outbox op for the same note. */
function pushOp(state: SyncState, op: Op): SyncState {
  return {
    ...state,
    outbox: [...state.outbox.filter((o) => o.noteId !== op.noteId), op],
  };
}

export function addNote(
  state: SyncState,
  text: string,
  reminderAt: number | null,
  now: number,
): { state: SyncState; note: Note } {
  const note: Note = {
    id: uid(),
    text,
    createdAt: now,
    updatedAt: now,
    reminderAt,
    deleted: false,
  };
  const op: Op = {
    id: uid(),
    kind: "upsert",
    noteId: note.id,
    text,
    reminderAt,
    createdAt: now,
    updatedAt: now,
  };
  const next = pushOp(
    { ...state, notes: { ...state.notes, [note.id]: note } },
    op,
  );
  return { state: next, note };
}

export function editNote(
  state: SyncState,
  id: string,
  text: string,
  reminderAt: number | null,
  now: number,
): SyncState {
  const prev = state.notes[id];
  if (!prev || prev.deleted) return state;
  const note: Note = { ...prev, text, reminderAt, updatedAt: now };
  const op: Op = {
    id: uid(),
    kind: "upsert",
    noteId: id,
    text,
    reminderAt,
    createdAt: note.createdAt,
    updatedAt: now,
  };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

export function deleteNote(state: SyncState, id: string, now: number): SyncState {
  const prev = state.notes[id];
  if (!prev) return state;
  const note: Note = { ...prev, deleted: true, reminderAt: null, updatedAt: now };
  const op: Op = { id: uid(), kind: "delete", noteId: id, updatedAt: now };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

/** Apply ops pulled from the server. Last-writer-wins on updatedAt. */
export function applyRemote(state: SyncState, ops: Op[]): SyncState {
  const notes = { ...state.notes };
  for (const op of ops) {
    const cur = notes[op.noteId];
    if (cur && cur.updatedAt > op.updatedAt) continue;
    if (op.kind === "delete") {
      notes[op.noteId] = cur
        ? { ...cur, deleted: true, reminderAt: null, updatedAt: op.updatedAt }
        : {
            id: op.noteId,
            text: "",
            createdAt: op.updatedAt,
            updatedAt: op.updatedAt,
            reminderAt: null,
            deleted: true,
          };
    } else {
      notes[op.noteId] = {
        id: op.noteId,
        text: op.text ?? "",
        createdAt: op.createdAt ?? op.updatedAt,
        updatedAt: op.updatedAt,
        reminderAt: op.reminderAt ?? null,
        deleted: false,
      };
    }
  }
  const seen = new Set(ops.map((o) => o.id));
  return { ...state, notes, outbox: state.outbox.filter((o) => !seen.has(o.id)) };
}

export function visibleNotes(state: SyncState): Note[] {
  return Object.values(state.notes).filter((n) => !n.deleted);
}
