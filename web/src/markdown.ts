// A small, safe Markdown subset for note bodies.
//
// Note bodies are stored and synced as plain text, so formatting is written
// with familiar Markdown marks (**bold**, # Heading, - [ ] task …) and turned
// into React elements when shown. Nothing here produces HTML strings, so a
// note can never inject markup or scripts; links only allow http(s)/mailto.
//
// Plain notes written before formatting existed render the same as before:
// line breaks are kept and unrecognised text is shown as-is.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del" | "mark"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export interface ListItem {
  /** Line index in the source (used to tick task boxes). */
  line: number;
  task: boolean;
  checked: boolean;
  content: Inline[];
  children: ListBlock | null;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { type: "paragraph"; content: Inline[] }
  | { type: "quote"; content: Inline[] }
  | { type: "code"; text: string }
  | { type: "hr" }
  | ListBlock;

/** `- item`, `* item`, `+ item`, `1. item`, `1) item`, optionally `[ ]`/`[x]`. */
export const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s{0,3}```/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeHref(url: string): string | null {
  const u = url.trim();
  return SAFE_URL.test(u) ? u : null;
}

/* ---------------- Inline ---------------- */

interface Delim {
  open: string;
  close: string;
  type: "strong" | "em" | "del" | "mark";
  /** `_` emphasis only counts at word boundaries (snake_case stays plain). */
  wordBound?: boolean;
}

// Longest markers first so ** wins over *.
const DELIMS: Delim[] = [
  { open: "**", close: "**", type: "strong" },
  { open: "__", close: "__", type: "strong", wordBound: true },
  { open: "~~", close: "~~", type: "del" },
  { open: "==", close: "==", type: "mark" },
  { open: "*", close: "*", type: "em" },
  { open: "_", close: "_", type: "em", wordBound: true },
];

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function findClose(src: string, from: number, d: Delim): number {
  let i = from;
  while (i < src.length) {
    const j = src.indexOf(d.close, i);
    if (j < 0) return -1;
    // Content must not end with whitespace and must be non-empty.
    if (j > from && !/\s/.test(src[j - 1]!) && src[j - 1] !== "\\") {
      // A single * must not be the start of ** (e.g. "*a **b** c*").
      if (d.close.length === 1 && src[j + 1] === d.close && src[j - 1] !== d.close) {
        i = j + 2;
        continue;
      }
      // In a longer run like "***", close with the last marks so the inner
      // ones can close a nested style ("**bold *italic***").
      let end = j;
      if (d.close.length > 1) {
        const c = d.close[0]!;
        while (src[end + d.close.length] === c) end++;
      }
      if (!d.wordBound || !isWordChar(src[end + d.close.length])) return end;
    }
    i = j + 1;
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  outer: while (i < src.length) {
    const ch = src[i]!;

    // Backslash escape: \* shows a literal *.
    if (ch === "\\" && i + 1 < src.length && /[\\`*_~=[\]()#>+\-.!|]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    // `inline code`
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // [label](url)
    if (ch === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        const href = safeHref(m[2]!);
        if (href) {
          flush();
          out.push({ type: "link", href, children: parseInline(m[1]!) });
          i += m[0].length;
          continue;
        }
      }
    }

    // Bare links: https://example.com
    if ((ch === "h" || ch === "H") && !isWordChar(src[i - 1])) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: "link", href: m[0], children: [{ type: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    for (const d of DELIMS) {
      if (!src.startsWith(d.open, i)) continue;
      const after = src[i + d.open.length];
      if (after === undefined || /\s/.test(after)) continue;
      if (d.wordBound && isWordChar(src[i - 1])) continue;
      const close = findClose(src, i + d.open.length, d);
      if (close < 0) continue;
      flush();
      out.push({
        type: d.type,
        children: parseInline(src.slice(i + d.open.length, close)),
      });
      i = close + d.close.length;
      continue outer;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/* ---------------- Blocks ---------------- */

interface RawItem {
  line: number;
  indent: number;
  ordered: boolean;
  num: number;
  task: boolean;
  checked: boolean;
  text: string;
}

function indentWidth(ws: string): number {
  let w = 0;
  for (const c of ws) w += c === "\t" ? 4 : 1;
  return w;
}

function parseListLine(line: string, index: number): RawItem | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const marker = m[2]!;
  const ordered = /\d/.test(marker);
  return {
    line: index,
    indent: indentWidth(m[1]!),
    ordered,
    num: ordered ? parseInt(marker, 10) : 1,
    task: m[3] !== undefined,
    checked: m[3] === "x" || m[3] === "X",
    text: m[4]!,
  };
}

/** Turns consecutive list lines into nested lists, by indentation. */
function buildList(items: RawItem[]): ListBlock {
  let pos = 0;
  const build = (indent: number): ListBlock => {
    const first = items[pos]!;
    const list: ListBlock = { type: "list", ordered: first.ordered, start: first.num, items: [] };
    while (pos < items.length) {
      const it = items[pos]!;
      if (it.indent < indent) break;
      if (it.indent > indent && list.items.length > 0) {
        const parent = list.items[list.items.length - 1]!;
        const child = build(it.indent);
        if (parent.children) parent.children.items.push(...child.items);
        else parent.children = child;
        continue;
      }
      list.items.push({
        line: it.line,
        task: it.task,
        checked: it.checked,
        content: parseInline(it.text),
        children: null,
      });
      pos++;
    }
    return list;
  };
  const top = build(items[0]!.indent);
  // Anything left (shallower than the first line) continues at top level.
  while (pos < items.length) top.items.push(...build(items[pos]!.indent).items);
  return top;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of text)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Math.min(h[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, content: parseInline(h[2]!) });
      i++;
      continue;
    }

    // Checked before lists: "- - -" is a divider, as in Markdown.
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        body.push(QUOTE_RE.exec(lines[i]!)![1]!);
        i++;
      }
      blocks.push({ type: "quote", content: parseInline(body.join("\n")) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: RawItem[] = [];
      while (i < lines.length) {
        const it = parseListLine(lines[i]!, i);
        if (!it) break;
        items.push(it);
        i++;
      }
      blocks.push(buildList(items));
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !FENCE_RE.test(lines[i]!) &&
      !HEADING_RE.test(lines[i]!) &&
      !QUOTE_RE.test(lines[i]!) &&
      !LIST_RE.test(lines[i]!) &&
      !HR_RE.test(lines[i]!)
    ) {
      body.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "paragraph", content: parseInline(body.join("\n")) });
  }
  return blocks;
}

/* ---------------- Helpers on the source text ---------------- */

/** Ticks or unticks the task box (`[ ]` ↔ `[x]`) on source line `lineIndex`. */
export function toggleTaskLine(src: string, lineIndex: number): string {
  const lines = src.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return src;
  const m = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)( |x|X)(\].*)$/.exec(line);
  if (!m) return src;
  lines[lineIndex] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
  return lines.join("\n");
}

/** Task boxes written in the body: how many and how many are ticked. */
export function taskProgress(src: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of src.split("\n")) {
    const m = LIST_RE.exec(line);
    if (m && m[3] !== undefined) {
      total++;
      if (m[3] !== " ") done++;
    }
  }
  return { done, total };
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === "text" || n.type === "code" ? n.text : inlineText(n.children)))
    .join("");
}

/** The note without formatting marks, for copying as plain text. */
export function toPlainText(src: string): string {
  const out: string[] = [];
  const walkList = (list: ListBlock, depth: number) => {
    list.items.forEach((it, idx) => {
      const marker = it.task
        ? it.checked
          ? "☑"
          : "☐"
        : list.ordered
          ? `${list.start + idx}.`
          : "•";
      out.push(`${"  ".repeat(depth)}${marker} ${inlineText(it.content)}`);
      if (it.children) walkList(it.children, depth + 1);
    });
  };
  for (const b of parseMarkdown(src)) {
    switch (b.type) {
      case "heading":
      case "paragraph":
        out.push(inlineText(b.content), "");
        break;
      case "quote":
        out.push(inlineText(b.content), "");
        break;
      case "code":
        out.push(b.text, "");
        break;
      case "hr":
        out.push("—————", "");
        break;
      case "list":
        walkList(b, 0);
        out.push("");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
