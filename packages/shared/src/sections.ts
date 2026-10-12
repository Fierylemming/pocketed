// Nested sections (sections → subsections → sub-subsections …). Pure helpers
// over a flat list of sections; the tree is described by each section's
// `parentId`.
//
// Sync is last-writer-wins per section, so two devices can briefly disagree in
// ways a single device never would: a subsection made offline inside a section
// another device deleted, or two sections moved inside each other. The tree is
// always read through `effectiveParentId`, which puts any section whose parent
// is missing, deleted, or part of such a loop at the top level — so nothing is
// ever hidden.

import { sortSections, type Section } from "./protocol";

type SectionLookup = ReadonlyMap<string, Section>;

function lookup(sections: readonly Section[]): Map<string, Section> {
  return new Map(sections.filter((s) => !s.deleted).map((s) => [s.id, s]));
}

/**
 * The parent a section is shown under: its stored parent when that parent is a
 * live section and following parents upward reaches the top without looping;
 * otherwise null (top level).
 */
export function effectiveParentId(byId: SectionLookup, section: Section): string | null {
  const parent = section.parentId ?? null;
  if (parent === null || !byId.has(parent)) return null;
  const seen = new Set<string>([section.id]);
  let cur: string | null = parent;
  while (cur !== null) {
    if (seen.has(cur)) return null; // loop
    seen.add(cur);
    const s = byId.get(cur);
    if (!s) return null;
    const next: string | null = s.parentId ?? null;
    cur = next !== null && byId.has(next) ? next : null;
  }
  return parent;
}

/** Live sections directly inside `parentId` (null = top level), oldest first. */
export function childSections(
  sections: readonly Section[],
  parentId: string | null,
): Section[] {
  const byId = lookup(sections);
  return sortSections(
    [...byId.values()].filter((s) => effectiveParentId(byId, s) === parentId),
  );
}

/** The chain from the top-level section down to `id` (inclusive). Empty when `id` isn't a live section. */
export function sectionPath(sections: readonly Section[], id: string | null): Section[] {
  if (id === null) return [];
  const byId = lookup(sections);
  const out: Section[] = [];
  let cur: Section | undefined = byId.get(id);
  while (cur) {
    out.unshift(cur);
    const parent = effectiveParentId(byId, cur);
    cur = parent === null ? undefined : byId.get(parent);
  }
  return out;
}

/** "Work › Projects › Alpha" */
export function sectionPathLabel(
  sections: readonly Section[],
  id: string | null,
  sep = " › ",
): string {
  return sectionPath(sections, id)
    .map((s) => s.name)
    .join(sep);
}

/** Every live section nested anywhere inside `id` (not including `id` itself). */
export function descendantSectionIds(sections: readonly Section[], id: string): Set<string> {
  const byId = lookup(sections);
  const children = new Map<string | null, string[]>();
  for (const s of byId.values()) {
    const p = effectiveParentId(byId, s);
    const list = children.get(p) ?? [];
    list.push(s.id);
    children.set(p, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/** Whether `id` may be moved inside `newParentId` (null = top level) without making a loop. */
export function canMoveSection(
  sections: readonly Section[],
  id: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return true;
  if (newParentId === id) return false;
  const byId = lookup(sections);
  if (!byId.has(newParentId)) return false;
  return !descendantSectionIds(sections, id).has(newParentId);
}

export interface SectionTreeRow {
  section: Section;
  /** 0 for top-level sections, 1 for their subsections, and so on. */
  depth: number;
  /** Number of live subsections directly inside. */
  childCount: number;
}

/**
 * The whole tree flattened depth-first (each section followed by its
 * subsections), for indented lists and dropdowns.
 */
export function flattenSectionTree(sections: readonly Section[]): SectionTreeRow[] {
  const byId = lookup(sections);
  const children = new Map<string | null, Section[]>();
  for (const s of sortSections([...byId.values()])) {
    const p = effectiveParentId(byId, s);
    const list = children.get(p) ?? [];
    list.push(s);
    children.set(p, list);
  }
  const out: SectionTreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      out.push({ section: s, depth, childCount: (children.get(s.id) ?? []).length });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
