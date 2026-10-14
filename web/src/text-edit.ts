// Pure text-editing operations behind the note editor's toolbar and keyboard
// shortcuts. Each takes the text plus the current selection and returns the
// new text plus where the selection should be, so they are easy to test and
// the editor can keep its own undo history.

import { LIST_RE } from "./markdown";

export interface EditState {
  value: string;
  start: number;
  end: number;
}

const clampSel = (s: EditState): EditState => {
  const n = s.value.length;
  const start = Math.max(0, Math.min(s.start, n));
  const end = Math.max(start, Math.min(s.end, n));
  return { value: s.value, start, end };
};

/** Replaces the selection with `text`, leaving the cursor after it (or selecting part of it). */
export function insertText(
  s: EditState,
  text: string,
  select?: { from: number; to: number },
): EditState {
  const { value, start, end } = clampSel(s);
  const next = value.slice(0, start) + text + value.slice(end);
  if (select) return { value: next, start: start + select.from, end: start + select.to };
  return { value: next, start: start + text.length, end: start + text.length };
}

/**
 * Wraps the selection in `before`/`after` (e.g. ** for bold), or removes them
 * when the selection is already wrapped. With nothing selected it inserts the
 * marks around a selected placeholder word.
 */
export function toggleWrap(
  s: EditState,
  before: string,
  after: string = before,
  placeholder = "text",
): EditState {
  const { value, start, end } = clampSel(s);
  const sel = value.slice(start, end);

  // Marks just outside the selection: **[word]**
  if (
    start - before.length >= 0 &&
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after &&
    marksMatch(runBefore(value, start), runAfter(value, end), before, after)
  ) {
    const next =
      value.slice(0, start - before.length) + sel + value.slice(end + after.length);
    return { value: next, start: start - before.length, end: end - before.length };
  }
  // Marks inside the selection: [**word**]
  if (
    sel.length > before.length + after.length &&
    sel.startsWith(before) &&
    sel.endsWith(after) &&
    marksMatch(runAfter(sel, 0), runBefore(sel, sel.length), before, after)
  ) {
    const inner = sel.slice(before.length, sel.length - after.length);
    const next = value.slice(0, start) + inner + value.slice(end);
    return { value: next, start, end: start + inner.length };
  }

  if (!sel) {
    const text = before + placeholder + after;
    return insertText(s, text, {
      from: before.length,
      to: before.length + placeholder.length,
    });
  }

  // Keep surrounding spaces outside the marks: " word " -> " **word** "
  const lead = /^\s*/.exec(sel)![0];
  const trail = /\s*$/.exec(sel.slice(lead.length))![0];
  const core = sel.slice(lead.length, sel.length - trail.length);
  if (!core) return { value, start, end };
  const text = lead + before + core + after + trail;
  const next = value.slice(0, start) + text + value.slice(end);
  const cs = start + lead.length + before.length;
  return { value: next, start: cs, end: cs + core.length };
}

/** The run of identical characters ending at `pos` (e.g. "**" before a word). */
function runBefore(value: string, pos: number): string {
  const c = value[pos - 1];
  if (!c) return "";
  let i = pos - 1;
  while (i > 0 && value[i - 1] === c) i--;
  return value.slice(i, pos);
}

/** The run of identical characters starting at `pos`. */
function runAfter(value: string, pos: number): string {
  const c = value[pos];
  if (!c) return "";
  let i = pos;
  while (i < value.length - 1 && value[i + 1] === c) i++;
  return value.slice(pos, i + 1);
}

/**
 * Whether the runs of mark characters around some text really are these
 * marks: "*" (italic) matches a run of 1 or 3, not the 2 of bold "**", so
 * italicising bold text adds italics instead of removing the bold.
 */
function marksMatch(left: string, right: string, before: string, after: string): boolean {
  const fits = (run: string, mark: string) => {
    if (mark.length === 0 || !/^(.)\1*$/.test(mark)) return true;
    return mark.length === 1 ? run.length % 2 === 1 : run.length >= mark.length;
  };
  return fits(left, before) && fits(right, after);
}

/** Start of the first selected line and end of the last selected line. */
export function lineBounds(value: string, start: number, end: number): [number, number] {
  const ls = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends right at the start of a line doesn't include that line.
  const effEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  let le = value.indexOf("\n", effEnd);
  if (le < 0) le = value.length;
  return [ls, le];
}

/** Applies `fn` to every selected line, keeping the selection over the same lines. */
function mapLines(
  s: EditState,
  fn: (lines: string[]) => string[],
): EditState {
  const { value, start, end } = clampSel(s);
  const [ls, le] = lineBounds(value, start, end);
  const before = value.slice(ls, le);
  const lines = before.split("\n");
  const after = fn(lines).join("\n");
  const next = value.slice(0, ls) + after + value.slice(le);
  if (start === end) {
    // Just a cursor (always one line): keep it beside the same text,
    // shifted by however much the line's prefix grew or shrank.
    const delta = after.length - before.length;
    const pos = Math.max(ls, Math.min(start + delta, ls + after.length));
    return { value: next, start: pos, end: pos };
  }
  return { value: next, start: ls, end: ls + after.length };
}

export type LineFormat = "bullet" | "number" | "task" | "quote";

const PREFIX_RE = /^(\s*)(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|>\s?)?/;
const HEADING_PREFIX_RE = /^(\s*)#{1,6}\s+/;

function hasFormat(line: string, fmt: LineFormat): boolean {
  switch (fmt) {
    case "bullet":
      return /^\s*[-*+]\s+(?!\[[ xX]\])/.test(line);
    case "number":
      return /^\s*\d{1,9}[.)]\s+/.test(line);
    case "task":
      return /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s+/.test(line);
    case "quote":
      return /^\s*>/.test(line);
  }
}

/**
 * Turns the selected lines into a bulleted / numbered / task list or a quote,
 * or back into plain lines when they all already are one.
 */
export function toggleLineFormat(s: EditState, fmt: LineFormat): EditState {
  return mapLines(s, (lines) => {
    const content = lines.filter((l) => l.trim());
    const allHave = content.length > 0 && content.every((l) => hasFormat(l, fmt));
    let n = 0;
    return lines.map((line) => {
      if (!line.trim() && lines.length > 1) return line;
      const m = PREFIX_RE.exec(line)!;
      const indent = m[1]!;
      const rest = line.slice(m[0].length).replace(HEADING_PREFIX_RE, "");
      if (allHave) return indent + rest;
      n++;
      const prefix =
        fmt === "bullet"
          ? "- "
          : fmt === "number"
            ? `${n}. `
            : fmt === "task"
              ? "- [ ] "
              : "> ";
      return indent + prefix + rest;
    });
  });
}

/** Makes the selected lines a heading of `level`, or plain text if they already are. */
export function toggleHeading(s: EditState, level: 1 | 2 | 3): EditState {
  const marks = "#".repeat(level) + " ";
  return mapLines(s, (lines) => {
    const all = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(marks));
    return lines.map((line) => {
      if (!line.trim() && lines.length > 1) return line;
      const stripped = line.replace(HEADING_PREFIX_RE, "$1");
      return all ? stripped : marks + stripped.trimStart();
    });
  });
}

/** Indents (or outdents) the selected lines by two spaces. */
export function indentLines(s: EditState, outdent = false): EditState {
  return mapLines(s, (lines) =>
    lines.map((line) => {
      if (outdent) return line.replace(/^( {1,2}|\t)/, "");
      return line.trim() || lines.length === 1 ? "  " + line : line;
    }),
  );
}

/** True when the cursor's line is a list item (so Tab should indent it). */
export function inListItem(s: EditState): boolean {
  const [ls, le] = lineBounds(s.value, s.start, s.start);
  return LIST_RE.test(s.value.slice(ls, le));
}

/**
 * Enter inside a list: starts the next item (next number, a fresh task box).
 * Enter on an empty item ends the list instead. Returns null when the cursor
 * isn't in a list or quote, so the normal newline happens.
 */
export function continueList(s: EditState): EditState | null {
  const { value, start, end } = clampSel(s);
  if (start !== end) return null;
  const ls = value.lastIndexOf("\n", start - 1) + 1;
  const lineToCursor = value.slice(ls, start);
  let le = value.indexOf("\n", start);
  if (le < 0) le = value.length;
  const fullLine = value.slice(ls, le);

  const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/.exec(fullLine);
  const quote = /^(\s*>\s?)/.exec(fullLine);
  const m = list ?? quote;
  if (!m || lineToCursor.length < m[0].length) return null;

  const content = fullLine.slice(m[0].length);
  if (!content.trim()) {
    // Empty item: end the list (remove the marker, keep the line).
    const next = value.slice(0, ls) + value.slice(ls + m[0].length);
    return { value: next, start: ls, end: ls };
  }

  let prefix: string;
  if (list) {
    const [, indent, marker, gap, task] = list;
    const num = /^(\d+)([.)])$/.exec(marker!);
    const nextMarker = num ? `${parseInt(num[1]!, 10) + 1}${num[2]}` : marker!;
    prefix = indent! + nextMarker + gap! + (task ? "[ ] " : "");
  } else {
    prefix = quote![1]!;
  }
  return insertText(s, "\n" + prefix);
}

/** Wraps the selection as a link; with no selection inserts a link template. */
export function insertLink(s: EditState, url?: string): EditState {
  const { value, start, end } = clampSel(s);
  const sel = value.slice(start, end);
  if (sel && /^https?:\/\/\S+$/i.test(sel.trim())) {
    // Selected text is itself a URL: make it the address and select the label.
    const text = `[link](${sel.trim()})`;
    return insertText(s, text, { from: 1, to: 5 });
  }
  const label = sel || "link text";
  const href = url ?? "https://";
  const text = `[${label}](${href})`;
  if (sel && url) return insertText(s, text);
  if (sel) {
    // Select the address so it can be typed over.
    return insertText(s, text, { from: label.length + 3, to: label.length + 3 + href.length });
  }
  return insertText(s, text, { from: 1, to: 1 + label.length });
}

/** Puts `block` on lines of its own (adding blank-line padding as needed). */
export function insertBlock(s: EditState, block: string, selectInBlock?: [number, number]): EditState {
  const { value, start, end } = clampSel(s);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const text = lead + block + trail;
  if (selectInBlock) {
    return insertText(s, text, {
      from: lead.length + selectInBlock[0],
      to: lead.length + selectInBlock[1],
    });
  }
  return insertText(s, text, { from: lead.length + block.length, to: lead.length + block.length });
}

/** Wraps the selected lines in a ``` code block (or inserts an empty one). */
export function insertCodeBlock(s: EditState): EditState {
  const { value, start, end } = clampSel(s);
  if (start === end) return insertBlock(s, "```\n\n```", [4, 4]);
  const [ls, le] = lineBounds(value, start, end);
  const inner = value.slice(ls, le);
  return insertBlock({ value, start: ls, end: le }, "```\n" + inner + "\n```", [
    4,
    4 + inner.length,
  ]);
}

/* ---------------- Tables & maths ---------------- */

/** Whether the line holds a `|` that isn't the escaped-literal `\|`. */
function hasPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      i++;
      continue;
    }
    if (line[i] === "|") return true;
  }
  return false;
}

/** Trimmed [start, end) of each cell in a table row line, as absolute offsets. */
function rowCellSpans(line: string, ls: number): Array<[number, number]> {
  const t = line.trimStart();
  const indent = line.length - t.length;
  const pipes: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      i++;
      continue;
    }
    if (t[i] === "|") pipes.push(i);
  }
  let from = 0;
  let to = t.length;
  if (t.startsWith("|")) from = 1;
  if (to > from && t.endsWith("|") && !t.endsWith("\\|") && pipes[pipes.length - 1] === to - 1) {
    to -= 1;
  }
  const spans: Array<[number, number]> = [];
  let segStart = from;
  for (const p of pipes) {
    if (p < from || p >= to) continue;
    spans.push([segStart, p]);
    segStart = p + 1;
  }
  spans.push([segStart, to]);
  return spans.map(([a, b]) => {
    while (a < b && /\s/.test(t[a]!)) a++;
    while (b > a && /\s/.test(t[b - 1]!)) b--;
    return [ls + indent + a, ls + indent + b] as [number, number];
  });
}

interface TableRow {
  ls: number;
  le: number;
  cells: Array<[number, number]>;
  divider: boolean;
}

/** The `--- | :---: | ---:` divider row under a table header. */
function isDividerRow(trimmed: string): boolean {
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const inner = body.endsWith("|") && !body.endsWith("\\|") ? body.slice(0, -1) : body;
  return inner.split(/(?<!\\)\|/).every((c) => /^:?-+:?$/.test(c.trim()));
}

/**
 * The pipe-delimited lines around the cursor, when they form a real table
 * (one of them is a `--- | ---` divider). Blank lines end the table.
 */
function findTable(value: string, pos: number): TableRow[] | null {
  const cursorStart = value.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = value.indexOf("\n", cursorStart);
  if (lineEnd < 0) lineEnd = value.length;
  if (!hasPipe(value.slice(cursorStart, lineEnd))) return null;

  let first = cursorStart;
  while (first > 0) {
    const prevStart = value.lastIndexOf("\n", first - 2) + 1;
    const prev = value.slice(prevStart, first - 1);
    if (!prev.trim() || !hasPipe(prev)) break;
    first = prevStart;
  }

  const rows: TableRow[] = [];
  let divider = false;
  for (let at = first; at <= value.length; ) {
    let end = value.indexOf("\n", at);
    if (end < 0) end = value.length;
    const line = value.slice(at, end);
    const trimmed = line.trim();
    if (!trimmed || !hasPipe(line)) break;
    const isDivider = isDividerRow(trimmed);
    if (isDivider) divider = true;
    rows.push({ ls: at, le: end, cells: rowCellSpans(line, at), divider: isDivider });
    if (end >= value.length) break;
    at = end + 1;
  }
  if (!divider || !rows.length) return null;
  return rows;
}

/** Wraps a cell's text so pipes inside it survive the table format. */
const escapeCell = (t: string) => t.trim().replace(/\|/g, "\\|");

const STARTER_TABLE = "| Column A | Column B |\n| --- | --- |\n|  |  |\n|  |  |";

/**
 * Inserts a table. With a selection: several lines become one row each
 * (the first line is the header); a single line is split on `|` into header
 * columns. With nothing selected: a small starter table.
 */
export function insertTable(s: EditState): EditState {
  const { value, start, end } = clampSel(s);
  const sel = value.slice(start, end);
  if (!sel.trim()) return insertBlock(s, STARTER_TABLE, [2, 10]);

  if (sel.includes("\n")) {
    const [ls, le] = lineBounds(value, start, end);
    const lines = value.slice(ls, le).split("\n").filter((l) => l.trim());
    const table = [
      `| ${escapeCell(lines[0]!)} |`,
      "| --- |",
      ...lines.slice(1).map((l) => `| ${escapeCell(l)} |`),
    ].join("\n");
    return insertBlock({ value, start: ls, end: le }, table);
  }

  const cells = (sel.includes("|") ? sel.split(/(?<!\\)\|/) : [sel])
    .map(escapeCell)
    .filter((c) => c);
  if (!cells.length) return insertBlock(s, STARTER_TABLE, [2, 10]);
  const divider = `| ${cells.map(() => "---").join(" | ")} |`;
  const blank = `| ${cells.map(() => " ").join(" | ")} |`;
  const table = [`| ${cells.join(" | ")} |`, divider, blank].join("\n");
  return insertBlock(s, table, [2, 2 + cells[0]!.length]);
}

/**
 * Tab between table cells: moves the selection onto the next (or previous)
 * cell's text, wrapping around the table. Null when not in a table.
 */
export function tableCellNav(s: EditState, dir: 1 | -1): EditState | null {
  const rows = findTable(s.value, s.start);
  if (!rows) return null;
  const cells = rows.filter((r) => !r.divider).flatMap((r) => r.cells);
  if (!cells.length) return null;
  let idx = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (s.start >= cells[i]![0]) {
      idx = i;
      break;
    }
  }
  idx = (idx + dir + cells.length) % cells.length;
  const [a, b] = cells[idx]!;
  return { value: s.value, start: a, end: b };
}

/**
 * Enter inside a table row: starts the next row (same number of cells, all
 * empty, cursor in the first). Enter on a row that's entirely empty removes
 * it and ends the table, like lists do. Null when not in a table.
 */
export function continueTable(s: EditState): EditState | null {
  const { value, start, end } = clampSel(s);
  if (start !== end) return null;
  const rows = findTable(value, start);
  if (!rows) return null;
  const row = rows.find((r) => start >= r.ls && start <= r.le);
  if (!row || row.divider) return null;

  const allEmpty = row.cells.every(([a, b]) => value.slice(a, b) === "");
  if (allEmpty) {
    // End the table: drop this row, and the line break before it when it
    // was the last row (so no blank line is left behind).
    const after = row.le < value.length ? value.slice(row.le + 1) : "";
    const from = after === "" && row.ls > 0 ? row.ls - 1 : row.ls;
    const next = value.slice(0, from) + after;
    const at = Math.min(from, next.length);
    return { value: next, start: at, end: at };
  }

  const emptyRow = `| ${row.cells.map(() => " ").join(" | ")} |`;
  const next = value.slice(0, row.le) + "\n" + emptyRow + value.slice(row.le);
  // The cursor lands in the new row's first cell: after "| " on that line.
  const at = row.le + 3;
  return { value: next, start: at, end: at };
}

/** Wraps the selection as $inline$ maths, or inserts a formula to edit. */
export function insertMath(s: EditState): EditState {
  return toggleWrap(s, "$", "$", "x^2");
}

/**
 * Puts the selected lines (or a sample formula) into a $$ display block,
 * where fractions and sums are drawn at full size.
 */
export function insertMathBlock(s: EditState): EditState {
  const { value, start, end } = clampSel(s);
  if (start === end) return insertBlock(s, "$$\n\\frac{a}{b}\n$$", [3, 14]);
  const [ls, le] = lineBounds(value, start, end);
  const inner = value.slice(ls, le);
  return insertBlock({ value, start: ls, end: le }, "$$\n" + inner + "\n$$");
}

/* ---------------- Find & replace ---------------- */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRegExp(query: string, opts: FindOptions): RegExp {
  const body = escapeRegExp(query);
  const src = opts.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(src, opts.caseSensitive ? "gu" : "giu");
}

/** Every [start, end) where `query` occurs. */
export function findMatches(
  value: string,
  query: string,
  opts: FindOptions = {},
): Array<[number, number]> {
  if (!query) return [];
  const re = findRegExp(query, opts);
  const out: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
    if (out.length >= 5000) break;
  }
  return out;
}

export function replaceAll(
  value: string,
  query: string,
  replacement: string,
  opts: FindOptions = {},
): { value: string; count: number } {
  if (!query) return { value, count: 0 };
  let count = 0;
  const next = value.replace(findRegExp(query, opts), () => {
    count++;
    return replacement;
  });
  return { value: next, count };
}

/* ---------------- Stats ---------------- */

export interface TextStats {
  words: number;
  chars: number;
  lines: number;
  /** Minutes at ~200 words a minute, at least 1 when there are words. */
  readingMinutes: number;
}

export function textStats(value: string): TextStats {
  // Words are runs containing a letter or digit, so formatting marks
  // ("#", "-", "[ ]", "**") don't count.
  const words = (value.replace(/\[[ xX]\]/g, " ").match(/\S+/g) ?? []).filter((w) =>
    /[\p{L}\p{N}]/u.test(w),
  ).length;
  return {
    words,
    chars: value.length,
    lines: value ? value.split("\n").length : 0,
    readingMinutes: words ? Math.max(1, Math.round(words / 200)) : 0,
  };
}

/** 1-based line and column of `pos`. */
export function cursorPosition(value: string, pos: number): { line: number; col: number } {
  const before = value.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - (before.lastIndexOf("\n") + 1) + 1;
  return { line, col };
}

/** "Tue 13 Oct 2026, 14:05" in the device's locale. */
export function formatTimestamp(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------------- Undo history ---------------- */

/**
 * Undo/redo for the editor. Typing in quick succession is grouped into one
 * step (like a regular text editor); toolbar actions are always their own step.
 */
export class EditHistory {
  private past: EditState[] = [];
  private future: EditState[] = [];
  private lastPush = 0;
  private lastKind: "type" | "action" | null = null;

  constructor(
    private readonly limit = 200,
    private readonly groupMs = 800,
  ) {}

  /** Call with the state *before* a change. */
  record(prev: EditState, kind: "type" | "action", now = Date.now()): void {
    const group =
      kind === "type" && this.lastKind === "type" && now - this.lastPush < this.groupMs;
    if (!group) {
      const top = this.past[this.past.length - 1];
      if (!top || top.value !== prev.value) {
        this.past.push(prev);
        if (this.past.length > this.limit) this.past.shift();
      }
    }
    this.lastPush = now;
    this.lastKind = kind;
    this.future = [];
  }

  undo(current: EditState): EditState | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    this.lastKind = null;
    return prev;
  }

  redo(current: EditState): EditState | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.lastKind = null;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastKind = null;
  }
}
