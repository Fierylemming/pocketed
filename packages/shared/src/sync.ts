// The offline-first sync engine. Pure functions over a plain state object so
// the same code runs in the browser, on the phone and in tests.

import {
  composeNoteText,
  DEFAULT_REMINDER_COLOR,
  sortSections,
  uid,
  type ChecklistItem,
  type ItemKind,
  type Note,
  type Op,
  type ReminderColorId,
  type Section,
} from "./protocol";

export interface SyncState {
  notes: Record<string, Note>;
  sections?: Record<string, Section>;
  /** Ops not yet accepted by the server. */
  outbox: Op[];
  /** Last server sequence number we have seen. */
  cursor: number;
}

export interface ItemExtraFields {
  kind?: ItemKind;
  title?: string;
  body?: string;
  sectionId?: string | null;
  location?: string | null;
  color?: ReminderColorId | null;
  images?: string[];
  checklist?: ChecklistItem[];
  pinned?: boolean;
}

export interface CreateNoteInput {
  title: string;
  body: string;
  sectionId?: string | null;
  images?: string[];
  checklist?: ChecklistItem[];
  pinned?: boolean;
}

export interface CreateReminderInput {
  title: string;
  body?: string;
  location?: string | null;
  reminderAt: number;
  color?: ReminderColorId | null;
  sectionId?: string | null;
}

export const emptyState = (): SyncState => ({
  notes: {},
  sections: {},
  outbox: [],
  cursor: 0,
});

function isSectionOp(op: Op): boolean {
  return op.kind === "section-upsert" || op.kind === "section-delete";
}

/** Append an op, collapsing any older outbox op for the same target entity. */
function pushOp(state: SyncState, op: Op): SyncState {
  const secOp = isSectionOp(op);
  return {
    ...state,
    outbox: [
      ...state.outbox.filter(
        (o) => !(o.noteId === op.noteId && isSectionOp(o) === secOp),
      ),
      op,
    ],
  };
}

export function addNote(
  state: SyncState,
  text: string,
  reminderAt: number | null,
  now: number,
  extra?: ItemExtraFields,
): { state: SyncState; note: Note } {
  const itemKind: ItemKind =
    extra?.kind ?? (reminderAt != null ? "reminder" : "note");
  const note: Note = {
    id: uid(),
    text,
    kind: itemKind,
    title: extra?.title,
    body: extra?.body,
    sectionId: extra?.sectionId ?? null,
    location: extra?.location ?? null,
    color: extra?.color ?? (itemKind === "reminder" ? DEFAULT_REMINDER_COLOR : null),
    images: extra?.images ?? [],
    checklist: extra?.checklist ?? [],
    pinned: extra?.pinned ?? false,
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
    itemKind: note.kind,
    title: note.title,
    body: note.body,
    sectionId: note.sectionId,
    location: note.location,
    color: note.color,
    images: note.images,
    checklist: note.checklist,
    pinned: note.pinned,
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

export function createNoteItem(
  state: SyncState,
  input: CreateNoteInput,
  now: number,
): { state: SyncState; note: Note } {
  const title = input.title.trim();
  const body = input.body;
  const text = composeNoteText(title, body);
  return addNote(state, text, null, now, {
    kind: "note",
    title,
    body,
    sectionId: input.sectionId ?? null,
    images: input.images ?? [],
    checklist: input.checklist ?? [],
    pinned: input.pinned ?? false,
  });
}

export function createReminderItem(
  state: SyncState,
  input: CreateReminderInput,
  now: number,
): { state: SyncState; note: Note } {
  const title = input.title.trim();
  const body = (input.body ?? "").trim();
  const text = composeNoteText(title, body);
  return addNote(state, text, input.reminderAt, now, {
    kind: "reminder",
    title,
    body,
    sectionId: input.sectionId ?? null,
    location: input.location?.trim() || null,
    color: input.color ?? DEFAULT_REMINDER_COLOR,
  });
}

export function editNote(
  state: SyncState,
  id: string,
  text: string,
  reminderAt: number | null,
  now: number,
  extra?: ItemExtraFields,
): SyncState {
  const prev = state.notes[id];
  if (!prev || prev.deleted) return state;
  const note: Note = {
    ...prev,
    text,
    reminderAt,
    kind: extra?.kind ?? prev.kind,
    title: extra?.title !== undefined ? extra.title : prev.title,
    body: extra?.body !== undefined ? extra.body : prev.body,
    sectionId: extra?.sectionId !== undefined ? extra.sectionId : prev.sectionId,
    location: extra?.location !== undefined ? extra.location : prev.location,
    color: extra?.color !== undefined ? extra.color : prev.color,
    images: extra?.images !== undefined ? extra.images : prev.images,
    checklist: extra?.checklist !== undefined ? extra.checklist : prev.checklist,
    pinned: extra?.pinned !== undefined ? extra.pinned : prev.pinned,
    updatedAt: now,
  };
  const op: Op = {
    id: uid(),
    kind: "upsert",
    noteId: id,
    text: note.text,
    itemKind: note.kind,
    title: note.title,
    body: note.body,
    sectionId: note.sectionId,
    location: note.location,
    color: note.color,
    images: note.images,
    checklist: note.checklist,
    pinned: note.pinned,
    reminderAt: note.reminderAt,
    createdAt: note.createdAt,
    updatedAt: now,
  };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

export function updateItem(
  state: SyncState,
  id: string,
  patch: Partial<Note>,
  now: number,
): SyncState {
  const prev = state.notes[id];
  if (!prev || prev.deleted) return state;
  const nextTitle = patch.title !== undefined ? patch.title : prev.title ?? "";
  const nextBody = patch.body !== undefined ? patch.body : prev.body ?? "";
  const nextText =
    patch.text !== undefined
      ? patch.text
      : patch.title !== undefined || patch.body !== undefined
        ? composeNoteText(nextTitle, nextBody)
        : prev.text;
  const nextReminderAt =
    patch.reminderAt !== undefined ? patch.reminderAt : prev.reminderAt;

  return editNote(state, id, nextText, nextReminderAt, now, {
    kind: patch.kind ?? prev.kind,
    title: patch.title !== undefined ? patch.title : prev.title,
    body: patch.body !== undefined ? patch.body : prev.body,
    sectionId: patch.sectionId !== undefined ? patch.sectionId : prev.sectionId,
    location: patch.location !== undefined ? patch.location : prev.location,
    color: patch.color !== undefined ? patch.color : prev.color,
    images: patch.images !== undefined ? patch.images : prev.images,
    checklist: patch.checklist !== undefined ? patch.checklist : prev.checklist,
    pinned: patch.pinned !== undefined ? patch.pinned : prev.pinned,
  });
}

export function deleteNote(state: SyncState, id: string, now: number): SyncState {
  const prev = state.notes[id];
  if (!prev) return state;
  const note: Note = { ...prev, deleted: true, reminderAt: null, updatedAt: now };
  const op: Op = { id: uid(), kind: "delete", noteId: id, updatedAt: now };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

// ---- Section operations ----

export function addSection(
  state: SyncState,
  name: string,
  now: number,
): { state: SyncState; section: Section } {
  const trimmed = name.trim();
  const section: Section = {
    id: uid(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  const op: Op = {
    id: uid(),
    kind: "section-upsert",
    noteId: section.id,
    sectionName: trimmed,
    createdAt: now,
    updatedAt: now,
  };
  const sections = { ...(state.sections ?? {}), [section.id]: section };
  return {
    state: pushOp({ ...state, sections }, op),
    section,
  };
}

export function renameSection(
  state: SyncState,
  id: string,
  name: string,
  now: number,
): SyncState {
  const sections = state.sections ?? {};
  const prev = sections[id];
  if (!prev || prev.deleted) return state;
  const trimmed = name.trim();
  if (!trimmed) return state;
  const section: Section = { ...prev, name: trimmed, updatedAt: now };
  const op: Op = {
    id: uid(),
    kind: "section-upsert",
    noteId: id,
    sectionName: trimmed,
    createdAt: section.createdAt,
    updatedAt: now,
  };
  return pushOp(
    { ...state, sections: { ...sections, [id]: section } },
    op,
  );
}

export function deleteSection(
  state: SyncState,
  id: string,
  now: number,
): SyncState {
  const sections = state.sections ?? {};
  const prev = sections[id];
  if (!prev) return state;
  const section: Section = { ...prev, deleted: true, updatedAt: now };
  const op: Op = {
    id: uid(),
    kind: "section-delete",
    noteId: id,
    updatedAt: now,
  };
  let next: SyncState = pushOp(
    { ...state, sections: { ...sections, [id]: section } },
    op,
  );
  // Also delete notes & reminders belonging to this section
  for (const n of Object.values(next.notes)) {
    if (!n.deleted && n.sectionId === id) {
      next = deleteNote(next, n.id, now);
    }
  }
  return next;
}

/** Apply ops pulled from the server. Last-writer-wins on updatedAt. */
export function applyRemote(state: SyncState, ops: Op[]): SyncState {
  const notes = { ...state.notes };
  const sections = { ...(state.sections ?? {}) };

  for (const op of ops) {
    if (op.kind === "section-upsert" || op.kind === "section-delete") {
      const curSec = sections[op.noteId];
      if (curSec && curSec.updatedAt > op.updatedAt) continue;
      if (op.kind === "section-delete") {
        sections[op.noteId] = curSec
          ? { ...curSec, deleted: true, updatedAt: op.updatedAt }
          : {
              id: op.noteId,
              name: "",
              createdAt: op.updatedAt,
              updatedAt: op.updatedAt,
              deleted: true,
            };
      } else {
        sections[op.noteId] = {
          id: op.noteId,
          name: op.sectionName ?? curSec?.name ?? "Untitled",
          createdAt: op.createdAt ?? curSec?.createdAt ?? op.updatedAt,
          updatedAt: op.updatedAt,
          deleted: false,
        };
      }
      continue;
    }

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
        kind:
          op.itemKind ??
          cur?.kind ??
          (op.reminderAt != null ? "reminder" : "note"),
        title: op.title ?? cur?.title,
        body: op.body ?? cur?.body,
        sectionId: op.sectionId !== undefined ? op.sectionId : (cur?.sectionId ?? null),
        location: op.location !== undefined ? op.location : (cur?.location ?? null),
        color: op.color !== undefined ? op.color : (cur?.color ?? null),
        images: op.images ?? cur?.images ?? [],
        checklist: op.checklist ?? cur?.checklist ?? [],
        pinned: op.pinned ?? cur?.pinned ?? false,
        createdAt: op.createdAt ?? cur?.createdAt ?? op.updatedAt,
        updatedAt: op.updatedAt,
        reminderAt: op.reminderAt ?? null,
        deleted: false,
      };
    }
  }
  const seen = new Set(ops.map((o) => o.id));
  return {
    ...state,
    notes,
    sections,
    outbox: state.outbox.filter((o) => !seen.has(o.id)),
  };
}

export function visibleNotes(state: SyncState): Note[] {
  return Object.values(state.notes).filter((n) => !n.deleted);
}

export function visibleSections(state: SyncState): Section[] {
  return sortSections(
    Object.values(state.sections ?? {}).filter((s) => !s.deleted),
  );
}
