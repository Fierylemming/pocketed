import { describe, expect, it } from "vitest";
import {
  addSection,
  applyRemote,
  createNoteItem,
  deleteSection,
  emptyState,
  moveSection,
  renameSection,
  visibleNotes,
  visibleSections,
  type SyncState,
} from "../src/sync";
import {
  canMoveSection,
  childSections,
  descendantSectionIds,
  flattenSectionTree,
  sectionPath,
  sectionPathLabel,
} from "../src/sections";
import { validateOp, type Section } from "../src/protocol";

const T0 = 1_700_000_000_000;

/** Work > Projects > Alpha, plus a separate top-level Home section. */
function tree() {
  let s: SyncState = emptyState();
  const work = addSection(s, "Work", T0);
  s = work.state;
  const projects = addSection(s, "Projects", T0 + 1, work.section.id);
  s = projects.state;
  const alpha = addSection(s, "Alpha", T0 + 2, projects.section.id);
  s = alpha.state;
  const home = addSection(s, "Home", T0 + 3);
  s = home.state;
  return { s, work: work.section, projects: projects.section, alpha: alpha.section, home: home.section };
}

describe("nested sections", () => {
  it("creates subsections and sub-subsections", () => {
    const { s, work, projects, alpha, home } = tree();
    const all = visibleSections(s);
    expect(childSections(all, null).map((x) => x.name)).toEqual(["Work", "Home"]);
    expect(childSections(all, work.id).map((x) => x.name)).toEqual(["Projects"]);
    expect(childSections(all, projects.id).map((x) => x.name)).toEqual(["Alpha"]);
    expect(childSections(all, home.id)).toEqual([]);
    expect(sectionPath(all, alpha.id).map((x) => x.name)).toEqual(["Work", "Projects", "Alpha"]);
    expect(sectionPathLabel(all, alpha.id)).toBe("Work › Projects › Alpha");
    expect([...descendantSectionIds(all, work.id)].sort()).toEqual([alpha.id, projects.id].sort());

    // The parent travels in the op so other devices build the same tree.
    const op = s.outbox.find((o) => o.noteId === alpha.id)!;
    expect(op.parentId).toBe(projects.id);
    expect(validateOp(op)).toBeNull();
  });

  it("flattens the tree depth-first for indented lists", () => {
    const { s } = tree();
    expect(
      flattenSectionTree(visibleSections(s)).map((r) => `${r.depth}:${r.section.name}:${r.childCount}`),
    ).toEqual(["0:Work:1", "1:Projects:1", "2:Alpha:0", "0:Home:0"]);
  });

  it("renaming keeps a subsection where it is", () => {
    const { s: s0, projects, work } = tree();
    const s = renameSection(s0, projects.id, "Clients", T0 + 10);
    expect(s.sections![projects.id].parentId).toBe(work.id);
    const op = s.outbox.find((o) => o.noteId === projects.id)!;
    expect(op.parentId).toBe(work.id);
    expect(op.sectionName).toBe("Clients");
  });

  it("moves a section (with its subsections) and refuses loops", () => {
    const { s: s0, work, projects, alpha, home } = tree();
    let s = moveSection(s0, projects.id, home.id, T0 + 10);
    const all = visibleSections(s);
    expect(sectionPathLabel(all, alpha.id)).toBe("Home › Projects › Alpha");
    expect(childSections(all, work.id)).toEqual([]);

    // Into itself or its own subsection: no change.
    expect(moveSection(s, projects.id, projects.id, T0 + 11)).toBe(s);
    expect(moveSection(s, projects.id, alpha.id, T0 + 11)).toBe(s);
    expect(canMoveSection(all, home.id, alpha.id)).toBe(false);
    expect(canMoveSection(all, alpha.id, work.id)).toBe(true);

    // Back to the top level.
    s = moveSection(s, alpha.id, null, T0 + 12);
    expect(childSections(visibleSections(s), null).map((x) => x.name)).toEqual(["Work", "Alpha", "Home"]); // oldest first
  });

  it("deleting a section deletes everything nested inside it", () => {
    let { s, work, projects, alpha, home } = tree();
    s = createNoteItem(s, { title: "in alpha", body: "", sectionId: alpha.id }, T0 + 5).state;
    s = createNoteItem(s, { title: "in projects", body: "", sectionId: projects.id }, T0 + 6).state;
    s = createNoteItem(s, { title: "in home", body: "", sectionId: home.id }, T0 + 7).state;

    s = deleteSection(s, work.id, T0 + 10);
    expect(visibleSections(s).map((x) => x.name)).toEqual(["Home"]);
    expect(visibleNotes(s).map((n) => n.title)).toEqual(["in home"]);
    const deletes = s.outbox.filter((o) => o.kind === "section-delete").map((o) => o.noteId);
    expect(deletes.sort()).toEqual([alpha.id, projects.id, work.id].sort());
  });

  it("applies remote parents, and keeps the parent for ops from older apps", () => {
    const { s: local } = tree();
    // A second device receives everything the first one made.
    let other = applyRemote(emptyState(), local.outbox);
    const byName = (st: SyncState, name: string) =>
      visibleSections(st).find((x) => x.name === name)!;
    expect(sectionPathLabel(visibleSections(other), byName(other, "Alpha").id)).toBe(
      "Work › Projects › Alpha",
    );

    // An app from before subsections renames Alpha (no parentId in its op).
    other = applyRemote(other, [
      {
        id: "old-app-rename",
        kind: "section-upsert",
        noteId: byName(other, "Alpha").id,
        sectionName: "Alpha v2",
        updatedAt: T0 + 50,
      },
    ]);
    expect(sectionPathLabel(visibleSections(other), byName(other, "Alpha v2").id)).toBe(
      "Work › Projects › Alpha v2",
    );
  });

  it("shows orphans and loops at the top level instead of hiding them", () => {
    const sec = (id: string, parentId: string | null, at: number): Section => ({
      id,
      name: id.toUpperCase(),
      parentId,
      createdAt: at,
      updatedAt: at,
      deleted: false,
    });
    const sections = [
      sec("a", "b", 1), // a and b each inside the other (two devices moved them at once)
      sec("b", "a", 2),
      sec("c", "gone", 3), // parent deleted elsewhere
      sec("d", "c", 4),
    ];
    expect(childSections(sections, null).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(childSections(sections, "c").map((x) => x.id)).toEqual(["d"]);
    expect(flattenSectionTree(sections).map((r) => r.section.id)).toEqual(["a", "b", "c", "d"]);
    expect(sectionPath(sections, "d").map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("validates parentId", () => {
    const base = {
      id: "op1",
      kind: "section-upsert" as const,
      noteId: "s1",
      sectionName: "X",
      updatedAt: 1,
    };
    expect(validateOp({ ...base, parentId: null })).toBeNull();
    expect(validateOp({ ...base, parentId: "s2" })).toBeNull();
    expect(validateOp({ ...base, parentId: "s1" })).toBe("op.parentId invalid");
    expect(validateOp({ ...base, parentId: "" })).toBe("op.parentId invalid");
    expect(validateOp({ ...base, parentId: 5 as unknown as string })).toBe("op.parentId invalid");
  });
});
