import { describe, expect, it } from "vitest";
import {
  addNote,
  applyRemote,
  deleteNote,
  editNote,
  emptyState,
  visibleNotes,
} from "../src/sync";
import { sortNotes, validateOp } from "../src/protocol";

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
      localOp, // server echo of our own op
    ]);
    expect(visibleNotes(s)).toHaveLength(2);
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

  it("sorts newest first with stable tie-break", () => {
    const mk = (id: string, updatedAt: number) => ({
      id,
      text: id,
      createdAt: 0,
      updatedAt,
      reminderAt: null,
      deleted: false,
    });
    const sorted = sortNotes([mk("b", 5), mk("a", 5), mk("c", 9)]);
    expect(sorted.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("validates ops", () => {
    expect(
      validateOp({ id: "x", kind: "upsert", noteId: "n", text: "t", updatedAt: 1 }),
    ).toBeNull();
    expect(
      validateOp({ id: "x", kind: "upsert", noteId: "n", updatedAt: 1 } as never),
    ).toMatch(/text/);
    expect(validateOp({ id: "", kind: "delete", noteId: "n", updatedAt: 1 })).toMatch(/id/);
  });
});
