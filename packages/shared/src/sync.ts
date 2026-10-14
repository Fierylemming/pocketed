// The offline-first sync engine. Pure functions over a plain state object so
// the same code runs in the browser, on the phone and in tests.

import {
  composeNoteText,
  DEFAULT_REMINDER_COLOR,
  sortSections,
  uid,
  type CalendarAccountSummary,
  type ChecklistItem,
  type ItemKind,
  type ItemSource,
  type Note,
  type Op,
  type RepeatId,
  type ReminderColorId,
  type Section,
} from "./protocol";
import { reminderAfterDone } from "./reminders";
import { canMoveSection, descendantSectionIds } from "./sections";

export interface SyncState {
  notes: Record<string, Note>;
  sections?: Record<string, Section>;
  /** Ops not yet accepted by the server. */
  outbox: Op[];
  /** Last server sequence number we have seen. */
  cursor: number;
  /** Latest server-owned visibility preferences; never placed in the notes outbox. */
  calendarAccounts?: CalendarAccountSummary[];
  calendarAccountsRevision?: number;
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
  repeat?: RepeatId | null;
  alertBefore?: number | null;
  endAt?: number | null;
  allDay?: boolean | null;
  source?: ItemSource | null;
  sourceRef?: string | null;
  sourceAccountId?: string | null;
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
  repeat?: RepeatId | null;
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
    repeat: reminderAt != null ? (extra?.repeat ?? "none") : null,
    alertBefore: extra?.alertBefore ?? null,
    endAt: reminderAt != null ? (extra?.endAt ?? null) : null,
    allDay: extra?.allDay ?? null,
    source: extra?.source ?? null,
    sourceRef: extra?.sourceRef ?? null,
    sourceAccountId: extra?.sourceAccountId ?? null,
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
    repeat: note.repeat,
    alertBefore: note.alertBefore,
    endAt: note.endAt ?? null,
    allDay: note.allDay ?? null,
    source: note.source,
    sourceRef: note.sourceRef,
    sourceAccountId: note.sourceAccountId ?? null,
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
    repeat: input.repeat ?? "none",
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
  const repeatRaw = extra?.repeat !== undefined ? extra.repeat : prev.repeat;
  const note: Note = {
    ...prev,
    text,
    reminderAt,
    repeat: reminderAt != null ? (repeatRaw ?? "none") : null,
    kind: extra?.kind ?? prev.kind,
    title: extra?.title !== undefined ? extra.title : prev.title,
    body: extra?.body !== undefined ? extra.body : prev.body,
    sectionId: extra?.sectionId !== undefined ? extra.sectionId : prev.sectionId,
    location: extra?.location !== undefined ? extra.location : prev.location,
    color: extra?.color !== undefined ? extra.color : prev.color,
    images: extra?.images !== undefined ? extra.images : prev.images,
    checklist: extra?.checklist !== undefined ? extra.checklist : prev.checklist,
    pinned: extra?.pinned !== undefined ? extra.pinned : prev.pinned,
    alertBefore: extra?.alertBefore !== undefined ? extra.alertBefore : (prev.alertBefore ?? null),
    endAt:
      reminderAt == null
        ? null
        : extra?.endAt !== undefined
          ? extra.endAt
          : (prev.endAt ?? null),
    allDay: extra?.allDay !== undefined ? extra.allDay : (prev.allDay ?? null),
    source: extra?.source !== undefined ? extra.source : (prev.source ?? null),
    sourceRef: extra?.sourceRef !== undefined ? extra.sourceRef : (prev.sourceRef ?? null),
    sourceAccountId: extra?.sourceAccountId !== undefined ? extra.sourceAccountId : (prev.sourceAccountId ?? null),
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
    repeat: note.repeat,
    alertBefore: note.alertBefore,
    endAt: note.endAt ?? null,
    allDay: note.allDay ?? null,
    source: note.source,
    sourceRef: note.sourceRef,
    sourceAccountId: note.sourceAccountId ?? null,
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
  // Moving a reminder that lasts a while (e.g. to its next repeat) moves its
  // end with it, so it keeps the same length.
  const nextEndAt =
    patch.endAt !== undefined
      ? patch.endAt
      : prev.endAt != null && prev.reminderAt != null && nextReminderAt != null
        ? prev.endAt + (nextReminderAt - prev.reminderAt)
        : null;

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
    repeat: patch.repeat !== undefined ? patch.repeat : prev.repeat,
    alertBefore: patch.alertBefore !== undefined ? patch.alertBefore : prev.alertBefore,
    endAt: nextEndAt,
    allDay: patch.allDay !== undefined ? patch.allDay : prev.allDay,
    source: patch.source !== undefined ? patch.source : prev.source,
    sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : prev.sourceRef,
    sourceAccountId: patch.sourceAccountId !== undefined ? patch.sourceAccountId : prev.sourceAccountId,
  });
}

/**
 * Marks a reminder's current occurrence as done. A repeating reminder rolls
 * forward to its next time; a one-off reminder is cleared (the note is kept).
 */
export function markReminderDone(state: SyncState, id: string, now: number): SyncState {
  const prev = state.notes[id];
  if (!prev || prev.deleted || prev.reminderAt == null) return state;
  const next = reminderAfterDone(prev.reminderAt, prev.repeat, now);
  return updateItem(state, id, { reminderAt: next, repeat: next == null ? null : prev.repeat }, now);
}

/**
 * Writes a whole item under a caller-chosen id: creates it, replaces it, or
 * brings a deleted one back. Used by importers, whose ids are deterministic.
 */
export function putItem(
  state: SyncState,
  id: string,
  fields: Omit<Note, "id" | "createdAt" | "updatedAt" | "deleted"> & { createdAt?: number },
  now: number,
): SyncState {
  const note: Note = {
    ...fields,
    id,
    repeat: fields.reminderAt != null ? (fields.repeat ?? "none") : null,
    endAt: fields.reminderAt != null ? (fields.endAt ?? null) : null,
    createdAt: fields.createdAt ?? now,
    updatedAt: now,
    deleted: false,
  };
  const op: Op = {
    id: uid(),
    kind: "upsert",
    noteId: id,
    text: note.text,
    itemKind: note.kind,
    title: note.title,
    body: note.body,
    sectionId: note.sectionId ?? null,
    location: note.location ?? null,
    color: note.color ?? null,
    images: note.images ?? [],
    checklist: note.checklist ?? [],
    pinned: note.pinned ?? false,
    reminderAt: note.reminderAt,
    repeat: note.repeat,
    alertBefore: note.alertBefore ?? null,
    endAt: note.endAt ?? null,
    allDay: note.allDay ?? null,
    source: note.source ?? null,
    sourceRef: note.sourceRef ?? null,
    sourceAccountId: note.sourceAccountId ?? null,
    createdAt: note.createdAt,
    updatedAt: now,
  };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

/** Importers may override the source reference to distinguish removal from manual dismissal. */
export function deleteNote(state: SyncState, id: string, now: number, sourceRef?: string): SyncState {
  const prev = state.notes[id];
  if (!prev) return state;
  const note: Note = { ...prev, sourceRef: sourceRef ?? prev.sourceRef, deleted: true, reminderAt: null, repeat: null, updatedAt: now };
  // Deletion can collapse an unsent upsert. Carry import identity/bookkeeping
  // on the tombstone so another device makes the same re-import decision.
  const op: Op = { id: uid(), kind: "delete", noteId: id, updatedAt: now, source: note.source ?? null, sourceRef: note.sourceRef ?? null, sourceAccountId: note.sourceAccountId ?? null };
  return pushOp({ ...state, notes: { ...state.notes, [id]: note } }, op);
}

// ---- Section operations ----

/**
 * Creates a section. Pass `parentId` to make it a subsection of an existing
 * section (subsections nest to any depth); null/omitted = top level.
 */
export function addSection(
  state: SyncState,
  name: string,
  now: number,
  parentId: string | null = null,
): { state: SyncState; section: Section } {
  const trimmed = name.trim();
  const sections = state.sections ?? {};
  const parent = parentId !== null && sections[parentId] && !sections[parentId].deleted
    ? parentId
    : null;
  const section: Section = {
    id: uid(),
    name: trimmed,
    parentId: parent,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  const op: Op = {
    id: uid(),
    kind: "section-upsert",
    noteId: section.id,
    sectionName: trimmed,
    parentId: parent,
    createdAt: now,
    updatedAt: now,
  };
  return {
    state: pushOp({ ...state, sections: { ...sections, [section.id]: section } }, op),
    section,
  };
}

function sectionUpsert(state: SyncState, section: Section): SyncState {
  const op: Op = {
    id: uid(),
    kind: "section-upsert",
    noteId: section.id,
    sectionName: section.name,
    parentId: section.parentId ?? null,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
  return pushOp(
    { ...state, sections: { ...(state.sections ?? {}), [section.id]: section } },
    op,
  );
}

export function renameSection(
  state: SyncState,
  id: string,
  name: string,
  now: number,
): SyncState {
  const prev = (state.sections ?? {})[id];
  if (!prev || prev.deleted) return state;
  const trimmed = name.trim();
  if (!trimmed) return state;
  return sectionUpsert(state, { ...prev, name: trimmed, updatedAt: now });
}

/**
 * Moves a section (with everything inside it) into `parentId`, or to the top
 * level when null. Refused (state unchanged) when the target is the section
 * itself or one of its own subsections.
 */
export function moveSection(
  state: SyncState,
  id: string,
  parentId: string | null,
  now: number,
): SyncState {
  const sections = state.sections ?? {};
  const prev = sections[id];
  if (!prev || prev.deleted) return state;
  if ((prev.parentId ?? null) === parentId) return state;
  if (!canMoveSection(Object.values(sections), id, parentId)) return state;
  return sectionUpsert(state, { ...prev, parentId, updatedAt: now });
}

/** Deletes a section, every subsection nested inside it, and all their notes & reminders. */
export function deleteSection(
  state: SyncState,
  id: string,
  now: number,
): SyncState {
  const sections = state.sections ?? {};
  const prev = sections[id];
  if (!prev) return state;
  const doomed = [id, ...descendantSectionIds(Object.values(sections), id)];
  let next: SyncState = state;
  for (const secId of doomed) {
    const sec = (next.sections ?? {})[secId];
    if (!sec) continue;
    const op: Op = {
      id: uid(),
      kind: "section-delete",
      noteId: secId,
      updatedAt: now,
    };
    next = pushOp(
      {
        ...next,
        sections: { ...(next.sections ?? {}), [secId]: { ...sec, deleted: true, updatedAt: now } },
      },
      op,
    );
  }
  // Also delete notes & reminders belonging to those sections
  const doomedSet = new Set(doomed);
  for (const n of Object.values(next.notes)) {
    if (!n.deleted && n.sectionId != null && doomedSet.has(n.sectionId)) {
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
          // Ops from apps that predate subsections carry no parentId: keep the current one.
          parentId: op.parentId !== undefined ? op.parentId : (curSec?.parentId ?? null),
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
      notes[op.noteId] = {
        ...(cur ?? { id: op.noteId, text: "", createdAt: op.updatedAt }),
        deleted: true,
        reminderAt: null,
        repeat: null,
        updatedAt: op.updatedAt,
        source: op.source !== undefined ? op.source : (cur?.source ?? null),
        sourceRef: op.sourceRef !== undefined ? op.sourceRef : (cur?.sourceRef ?? null),
        sourceAccountId: op.sourceAccountId !== undefined ? op.sourceAccountId : (cur?.sourceAccountId ?? null),
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
        repeat:
          op.reminderAt == null
            ? null
            : (op.repeat !== undefined ? op.repeat : (cur?.repeat ?? "none")),
        alertBefore:
          op.alertBefore !== undefined ? op.alertBefore : (cur?.alertBefore ?? null),
        endAt:
          op.reminderAt == null
            ? null
            : op.endAt !== undefined
              ? op.endAt
              : (cur?.endAt ?? null),
        allDay: op.allDay !== undefined ? op.allDay : (cur?.allDay ?? null),
        source: op.source !== undefined ? op.source : (cur?.source ?? null),
        sourceRef: op.sourceRef !== undefined ? op.sourceRef : (cur?.sourceRef ?? null),
        sourceAccountId: op.sourceAccountId !== undefined ? op.sourceAccountId : (cur?.sourceAccountId ?? null),
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
