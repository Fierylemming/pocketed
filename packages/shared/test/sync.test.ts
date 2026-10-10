import { describe, expect, it } from "vitest";
import {
  addNote,
  addSection,
  applyRemote,
  createNoteItem,
  createReminderItem,
  deleteNote,
  deleteSection,
  editNote,
  emptyState,
  renameSection,
  updateItem,
  visibleNotes,
  visibleSections,
} from "../src/sync";
import { isReminderItem, itemBody, itemTitle, sortNotes, validateOp } from "../src/protocol";

const T0 = 1_700_000_000_000;

describe("sync engine", () => {
  it("adds, edits and deletes locally", () => {
    let s = emptyState();
    const r = addNote(s, "buy milk", null, T0);
    s = r.state;
    expect(visibleNotes(s)).toHaveLength(1);
    expect(s.outbox).toHaveLength(1);

    s = editNote(s, r.note.id, "buy oat milk", null, T0 + 1);
    expect(s.notes[r.note.id].text).toBe("buy oat milk");
    // outbox collapsed to the newest op for that note
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0].text).toBe("buy oat milk");

    s = deleteNote(s, r.note.id, T0 + 2);
    expect(visibleNotes(s)).toHaveLength(0);
    expect(s.outbox[0].kind).toBe("delete");
  });

  it("creates, renames and deletes sections and syncs items inside them", () => {
    let s = emptyState();
    const secRes = addSection(s, "Work Projects", T0);
    s = secRes.state;
    expect(visibleSections(s).map((sec) => sec.name)).toEqual(["Work Projects"]);

    const noteRes = createNoteItem(
      s,
      {
        title: "Architecture Spec",
        body: "Detailed system design with diagrams.",
        sectionId: secRes.section.id,
        images: ["data:image/png;base64,iVBORw0KGgo="],
        checklist: [{ id: "c1", text: "Write tests", done: false }],
        pinned: true,
      },
      T0 + 1,
    );
    s = noteRes.state;

    const remRes = createReminderItem(
      s,
      {
        title: "Design review",
        body: "Bring slides",
        location: "Conference Room B",
        reminderAt: T0 + 3_600_000,
        color: "emerald",
        sectionId: secRes.section.id,
      },
      T0 + 2,
    );
    s = remRes.state;

    expect(isReminderItem(noteRes.note)).toBe(false);
    expect(itemTitle(noteRes.note)).toBe("Architecture Spec");
    expect(itemBody(noteRes.note)).toBe("Detailed system design with diagrams.");
    expect(noteRes.note.images).toHaveLength(1);

    expect(isReminderItem(remRes.note)).toBe(true);
    expect(remRes.note.location).toBe("Conference Room B");
    expect(remRes.note.color).toBe("emerald");

    s = renameSection(s, secRes.section.id, "Engineering", T0 + 3);
    expect(visibleSections(s)[0].name).toBe("Engineering");

    s = updateItem(s, noteRes.note.id, { title: "Updated Spec" }, T0 + 4);
    expect(itemTitle(s.notes[noteRes.note.id])).toBe("Updated Spec");

    s = deleteSection(s, secRes.section.id, T0 + 5);
    expect(visibleSections(s)).toHaveLength(0);
    expect(visibleNotes(s)).toHaveLength(0);
  });

  it("applies remote ops and clears echoed outbox entries", () => {
    let s = emptyState();
    const r = addNote(s, "local", null, T0);
    s = r.state;
    const localOp = s.outbox[0];

    s = applyRemote(s, [
      {
        id: "remote-1",
        kind: "upsert",
        noteId: "n-remote",
        text: "from phone",
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: "remote-sec",
        kind: "section-upsert",
        noteId: "sec-1",
        sectionName: "Shopping",
        createdAt: T0,
        updatedAt: T0,
      },
      localOp, // server echo of our own op
    ]);
    expect(visibleNotes(s)).toHaveLength(2);
    expect(visibleSections(s).map((sec) => sec.name)).toEqual(["Shopping"]);
    expect(s.outbox).toHaveLength(0);
  });

  it("last-writer-wins on conflicts", () => {
    let s = emptyState();
    s = applyRemote(s, [
      { id: "a", kind: "upsert", noteId: "n1", text: "old", createdAt: T0, updatedAt: T0 },
    ]);
    s = applyRemote(s, [
      { id: "b", kind: "upsert", noteId: "n1", text: "new", createdAt: T0, updatedAt: T0 + 5 },
    ]);
    expect(s.notes.n1.text).toBe("new");
    // an older op arriving late must not overwrite
    s = applyRemote(s, [
      { id: "c", kind: "upsert", noteId: "n1", text: "stale", createdAt: T0, updatedAt: T0 + 1 },
    ]);
    expect(s.notes.n1.text).toBe("new");
  });

  it("delete wins as a tombstone for unknown notes", () => {
    let s = emptyState();
    s = applyRemote(s, [{ id: "d", kind: "delete", noteId: "ghost", updatedAt: T0 }]);
    expect(s.notes.ghost.deleted).toBe(true);
    expect(visibleNotes(s)).toHaveLength(0);
  });

  it("sorts pinned first, then newest first with stable tie-break", () => {
    const mk = (id: string, updatedAt: number, pinned = false) => ({
      id,
      text: id,
      pinned,
      createdAt: 0,
      updatedAt,
      reminderAt: null,
      deleted: false,
    });
    const sorted = sortNotes([mk("b", 5), mk("a", 5), mk("c", 9), mk("p", 1, true)]);
    expect(sorted.map((n) => n.id)).toEqual(["p", "c", "a", "b"]);
  });

  it("validates ops", () => {
    expect(
      validateOp({ id: "x", kind: "upsert", noteId: "n", text: "t", updatedAt: 1 }),
    ).toBeNull();
    expect(
      validateOp({
        id: "sec",
        kind: "section-upsert",
        noteId: "s1",
        sectionName: "Personal",
        updatedAt: 1,
      }),
    ).toBeNull();
    expect(
      validateOp({
        id: "bad-col",
        kind: "upsert",
        noteId: "n",
        text: "t",
        color: "neon-invalid" as never,
        updatedAt: 1,
      }),
    ).toMatch(/color/);
    expect(
      validateOp({ id: "x", kind: "upsert", noteId: "n", updatedAt: 1 } as never),
    ).toMatch(/text/);
    expect(validateOp({ id: "", kind: "delete", noteId: "n", updatedAt: 1 })).toMatch(/id/);
  });
});
