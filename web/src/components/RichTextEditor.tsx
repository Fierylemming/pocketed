import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toggleTaskLine } from "../markdown";
import {
  continueList,
  continueTable,
  cursorPosition,
  EditHistory,
  findMatches,
  formatTimestamp,
  indentLines,
  inListItem,
  insertBlock,
  insertCodeBlock,
  insertLink,
  insertMath,
  insertMathBlock,
  insertTable,
  insertText,
  replaceAll,
  tableCellNav,
  textStats,
  toggleHeading,
  toggleLineFormat,
  toggleWrap,
  type EditState,
} from "../text-edit";
import { MarkdownView } from "./MarkdownView";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";

type Action =
  | "bold"
  | "italic"
  | "strike"
  | "highlight"
  | "code"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "number"
  | "task"
  | "quote"
  | "codeblock"
  | "link"
  | "hr"
  | "date"
  | "table"
  | "math"
  | "mathBlock"
  | "indent"
  | "outdent";

function runAction(s: EditState, a: Action): EditState {
  switch (a) {
    case "bold":
      return toggleWrap(s, "**", "**", "bold text");
    case "italic":
      return toggleWrap(s, "*", "*", "italic text");
    case "strike":
      return toggleWrap(s, "~~", "~~", "struck text");
    case "highlight":
      return toggleWrap(s, "==", "==", "highlighted text");
    case "code":
      return toggleWrap(s, "`", "`", "code");
    case "h1":
      return toggleHeading(s, 1);
    case "h2":
      return toggleHeading(s, 2);
    case "h3":
      return toggleHeading(s, 3);
    case "bullet":
    case "number":
    case "task":
    case "quote":
      return toggleLineFormat(s, a);
    case "codeblock":
      return insertCodeBlock(s);
    case "link":
      return insertLink(s);
    case "hr":
      return insertBlock(s, "---\n");
    case "date":
      return insertText(s, formatTimestamp(new Date()));
    case "table":
      return insertTable(s);
    case "math":
      return insertMath(s);
    case "mathBlock":
      return insertMathBlock(s);
    case "indent":
      return indentLines(s);
    case "outdent":
      return indentLines(s, true);
  }
}

interface ToolDef {
  action: Action;
  label: ReactNode;
  title: string;
  className?: string;
}

const TOOL_GROUPS: ToolDef[][] = [
  [
    { action: "bold", label: <b>B</b>, title: `Bold (${MOD}+B)` },
    { action: "italic", label: <i>I</i>, title: `Italic (${MOD}+I)` },
    { action: "strike", label: <s>S</s>, title: `Strikethrough (${MOD}+Shift+S)` },
    { action: "highlight", label: <span className="rte-hl-icon">H</span>, title: `Highlight (${MOD}+Shift+H)` },
    { action: "code", label: <code>{"</>"}</code>, title: `Inline code (${MOD}+E)` },
  ],
  [
    { action: "h1", label: "H1", title: `Heading 1 (${MOD}+${ALT}+1)` },
    { action: "h2", label: "H2", title: `Heading 2 (${MOD}+${ALT}+2)` },
    { action: "h3", label: "H3", title: `Heading 3 (${MOD}+${ALT}+3)` },
  ],
  [
    { action: "bullet", label: "•≡", title: `Bulleted list (${MOD}+Shift+8)` },
    { action: "number", label: "1≡", title: `Numbered list (${MOD}+Shift+7)` },
    { action: "task", label: "☑", title: `Task list (${MOD}+Shift+9)` },
    { action: "outdent", label: "⇤", title: "Decrease indent (Shift+Tab)" },
    { action: "indent", label: "⇥", title: "Increase indent (Tab in a list)" },
  ],
  [
    { action: "table", label: "⊞", title: "Table (with lines selected, they become the rows)" },
    { action: "math", label: "x²", title: `Maths formula (${MOD}+Shift+M)` },
    { action: "mathBlock", label: "∑", title: "Maths block — full-size fractions & sums" },
  ],
  [
    { action: "quote", label: "❝", title: "Quote" },
    { action: "codeblock", label: "{ }", title: "Code block" },
    { action: "link", label: "🔗", title: `Link (${MOD}+K)` },
    { action: "hr", label: "―", title: "Divider line" },
    { action: "date", label: "🕒", title: `Insert date & time (${MOD}+Shift+D)` },
  ],
];

const SHORTCUTS: Array<[string, string]> = [
  [`${MOD}+B / I / E`, "Bold / italic / inline code"],
  [`${MOD}+Shift+S`, "Strikethrough"],
  [`${MOD}+Shift+H`, "Highlight"],
  [`${MOD}+K`, "Link (or paste a URL over selected text)"],
  [`${MOD}+${ALT}+1 / 2 / 3`, "Heading 1 / 2 / 3"],
  [`${MOD}+Shift+8 / 7 / 9`, "Bullets / numbers / tasks"],
  [`${MOD}+Shift+M`, "Maths formula ($…$)"],
  ["Enter", "Continue a list or table row · on an empty one, end it"],
  ["Tab / Shift+Tab", "Jump between table cells · indent list items"],
  [`${MOD}+Z / ${MOD}+Shift+Z`, "Undo / redo"],
  [`${MOD}+F`, "Find & replace"],
  [`${MOD}+Shift+D`, "Insert date & time"],
  [`${MOD}+Enter`, "Save the note"],
  ["Esc", "Leave focus mode / close find"],
];

const SYNTAX: Array<[string, string]> = [
  ["**bold**  *italic*  ~~struck~~", "Text styles"],
  ["==highlight==  `code`", "Highlight & code"],
  ["# Heading  ## Smaller", "Headings"],
  ["- item   1. item", "Lists"],
  ["- [ ] task   - [x] done", "Tick-able tasks"],
  ["| a | b |  over  | --- | --- |", "Table (⊞ inserts one)"],
  ["$x^2$   $H_{2}O$   $\\frac{a}{b}$", "Maths, inline"],
  ["$$ … $$ on its own lines", "Maths block"],
  ["> quote", "Quote"],
  ["[label](https://…)", "Link"],
  ["---", "Divider"],
];

export interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  ariaLabel: string;
  minRows?: number;
  /** Ctrl/⌘+Enter. */
  onSubmitShortcut?: () => void;
  /** Shown in focus mode's header. */
  focusTitle?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  maxLength,
  ariaLabel,
  minRows = 5,
  onSubmitShortcut,
  focusTitle,
}: RichTextEditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const history = useRef(new EditHistory());
  const lastValue = useRef(value);
  const sel = useRef<[number, number]>([value.length, value.length]);
  const pendingSel = useRef<[number, number] | null>(null);

  const [, bump] = useState(0);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [focusMode, setFocusMode] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [findNote, setFindNote] = useState<string | null>(null);

  // The text was replaced from outside (e.g. the composer was cleared after
  // saving): that isn't something to undo back into.
  if (value !== lastValue.current) {
    lastValue.current = value;
    history.current.clear();
  }

  const matches = useMemo(
    () => (findOpen ? findMatches(value, findQuery, { caseSensitive, wholeWord }) : []),
    [findOpen, value, findQuery, caseSensitive, wholeWord],
  );
  const current = matches.length ? Math.min(matchIndex, matches.length - 1) : -1;

  const stats = textStats(value);

  /* ---- sizing: the box grows with its text, like a page ---- */
  function resize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }

  useLayoutEffect(() => {
    resize();
    const ta = taRef.current;
    if (ta && pendingSel.current) {
      const [s, e] = pendingSel.current;
      pendingSel.current = null;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(s, e);
      sel.current = [s, e];
      setCursor(cursorPosition(ta.value, s));
    }
  });

  useEffect(() => {
    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Focus mode: Esc anywhere leaves it; the page behind doesn't scroll.
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !findOpen && !showHelp) setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.classList.add("rte-focus-lock");
    requestAnimationFrame(() => taRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("rte-focus-lock");
    };
  }, [focusMode, findOpen, showHelp]);

  // Bring the current find match into view.
  useEffect(() => {
    if (current < 0) return;
    const el = backdropRef.current?.querySelector(".rte-hit.current");
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current, findQuery]);

  function state(): EditState {
    const ta = taRef.current;
    if (ta) return { value, start: ta.selectionStart, end: ta.selectionEnd };
    return { value, start: sel.current[0], end: sel.current[1] };
  }

  function commit(next: EditState, moveCursor = true) {
    if (next.value === value) {
      if (moveCursor) pendingSel.current = [next.start, next.end];
      bump((n) => n + 1);
      return;
    }
    if (maxLength && next.value.length > maxLength) return;
    history.current.record(state(), "action");
    lastValue.current = next.value;
    if (moveCursor) pendingSel.current = [next.start, next.end];
    onChange(next.value);
    bump((n) => n + 1);
  }

  function apply(a: Action) {
    if (mode === "preview") setMode("write");
    commit(runAction(state(), a));
  }

  function undo() {
    const prev = history.current.undo(state());
    if (!prev) return;
    lastValue.current = prev.value;
    pendingSel.current = [prev.start, prev.end];
    onChange(prev.value);
    bump((n) => n + 1);
  }

  function redo() {
    const next = history.current.redo(state());
    if (!next) return;
    lastValue.current = next.value;
    pendingSel.current = [next.start, next.end];
    onChange(next.value);
    bump((n) => n + 1);
  }

  function handleTyping(next: string) {
    history.current.record(
      { value: lastValue.current, start: sel.current[0], end: sel.current[1] },
      "type",
    );
    lastValue.current = next;
    onChange(next);
  }

  function trackSelection() {
    const ta = taRef.current;
    if (!ta) return;
    sel.current = [ta.selectionStart, ta.selectionEnd];
    setCursor(cursorPosition(ta.value, ta.selectionStart));
  }

  function openFind() {
    const ta = taRef.current;
    if (ta && ta.selectionEnd > ta.selectionStart) {
      const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (!picked.includes("\n")) setFindQuery(picked);
    }
    setMode("write");
    setFindOpen(true);
    setFindNote(null);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function closeFind() {
    setFindOpen(false);
    setFindNote(null);
    const m = matches[current];
    if (m) pendingSel.current = m;
    taRef.current?.focus();
    bump((n) => n + 1);
  }

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    const next = (current + dir + matches.length) % matches.length;
    setMatchIndex(next);
    const m = matches[next]!;
    taRef.current?.setSelectionRange(m[0], m[1]);
    sel.current = m;
  }

  function replaceOne() {
    const m = matches[current];
    if (!m) return;
    commit(insertText({ value, start: m[0], end: m[1] }, replaceWith));
    // Stay in the find box for the next one.
    requestAnimationFrame(() => findInputRef.current?.focus());
    setFindNote(null);
  }

  function replaceEverything() {
    const res = replaceAll(value, findQuery, replaceWith, { caseSensitive, wholeWord });
    if (!res.count) return;
    commit({ value: res.value, start: 0, end: 0 });
    requestAnimationFrame(() => findInputRef.current?.focus());
    setFindNote(`Replaced ${res.count} ${res.count === 1 ? "match" : "matches"}`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && !e.altKey) {
      let handled = true;
      if (key === "z" && !e.shiftKey) undo();
      else if ((key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey)) redo();
      else if (key === "b" && !e.shiftKey) apply("bold");
      else if (key === "i" && !e.shiftKey) apply("italic");
      else if (key === "e" && !e.shiftKey) apply("code");
      else if (key === "k" && !e.shiftKey) apply("link");
      else if (key === "s" && e.shiftKey) apply("strike");
      else if (key === "h" && e.shiftKey) apply("highlight");
      else if (key === "d" && e.shiftKey) apply("date");
      else if (key === "m" && e.shiftKey) apply("math");
      else if (e.shiftKey && e.code === "Digit8") apply("bullet");
      else if (e.shiftKey && e.code === "Digit7") apply("number");
      else if (e.shiftKey && e.code === "Digit9") apply("task");
      else if (key === "f" && !e.shiftKey) openFind();
      else if (key === "enter" && onSubmitShortcut) onSubmitShortcut();
      else handled = false;
      if (handled) {
        e.preventDefault();
        return;
      }
    }
    if (mod && e.altKey && !e.shiftKey) {
      const level = { Digit1: "h1", Digit2: "h2", Digit3: "h3" }[e.code] as Action | undefined;
      if (level) {
        e.preventDefault();
        apply(level);
        return;
      }
    }

    if (e.key === "Tab" && !mod && !e.altKey) {
      const s = state();
      // Inside a table, Tab walks through the cells.
      const cell = tableCellNav(s, e.shiftKey ? -1 : 1);
      if (cell) {
        e.preventDefault();
        commit(cell);
        return;
      }
      const multiLine = value.slice(s.start, s.end).includes("\n");
      // Only inside lists or across several lines, so Tab still moves focus elsewhere.
      if (multiLine || inListItem(s)) {
        e.preventDefault();
        apply(e.shiftKey ? "outdent" : "indent");
      }
      return;
    }

    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
      const next = continueList(state()) ?? continueTable(state());
      if (next) {
        e.preventDefault();
        commit(next);
      }
      return;
    }

    if (e.key === "Escape" && findOpen) {
      e.preventDefault();
      closeFind();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData("text/plain").trim();
    const s = state();
    // Pasting a web address over selected words turns them into a link.
    if (s.end > s.start && /^https?:\/\/\S+$/i.test(text) && !/\n/.test(value.slice(s.start, s.end))) {
      e.preventDefault();
      commit(insertLink(s, text));
    }
  }

  function onFindKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
  }

  // Text behind the textarea with find matches marked, laid out identically.
  function renderBackdrop() {
    const parts: ReactNode[] = [];
    let at = 0;
    matches.forEach(([s, e], i) => {
      if (s > at) parts.push(value.slice(at, s));
      parts.push(
        <mark key={i} className={"rte-hit" + (i === current ? " current" : "")}>
          {value.slice(s, e)}
        </mark>,
      );
      at = e;
    });
    parts.push(value.slice(at) + "\u200b");
    return parts;
  }

  const noop = (e: { preventDefault: () => void }) => e.preventDefault();
  const tb = (def: ToolDef) => (
    <button
      key={def.action}
      type="button"
      className="rte-btn"
      title={def.title}
      aria-label={def.title}
      onMouseDown={noop}
      onClick={() => apply(def.action)}
    >
      {def.label}
    </button>
  );

  return (
    <div className={"rte" + (focusMode ? " rte-focus" : "")}>
      {focusMode && (
        <div className="rte-focus-head">
          <span className="rte-focus-title">{focusTitle?.trim() || "Focus mode"}</span>
          <button type="button" className="small-btn" onClick={() => setFocusMode(false)}>
            ✕ Exit focus mode
          </button>
        </div>
      )}

      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        <div className="rte-group">
          <button
            type="button"
            className="rte-btn"
            title={`Undo (${MOD}+Z)`}
            aria-label="Undo"
            disabled={!history.current.canUndo}
            onMouseDown={noop}
            onClick={undo}
          >
            ↶
          </button>
          <button
            type="button"
            className="rte-btn"
            title={`Redo (${MOD}+Shift+Z)`}
            aria-label="Redo"
            disabled={!history.current.canRedo}
            onMouseDown={noop}
            onClick={redo}
          >
            ↷
          </button>
        </div>
        {TOOL_GROUPS.map((g, i) => (
          <div key={i} className="rte-group">
            {g.map(tb)}
          </div>
        ))}
        <div className="rte-group rte-group-end">
          <button
            type="button"
            className={"rte-btn" + (findOpen ? " on" : "")}
            title={`Find & replace (${MOD}+F)`}
            aria-label="Find and replace"
            aria-pressed={findOpen}
            onMouseDown={noop}
            onClick={() => (findOpen ? closeFind() : openFind())}
          >
            🔍
          </button>
          <button
            type="button"
            className={"rte-btn rte-wide" + (mode === "preview" ? " on" : "")}
            title="Preview the formatted note"
            aria-pressed={mode === "preview"}
            onMouseDown={noop}
            onClick={() => setMode((m) => (m === "preview" ? "write" : "preview"))}
          >
            {mode === "preview" ? "✏️ Write" : "👁 Preview"}
          </button>
          <button
            type="button"
            className={"rte-btn" + (focusMode ? " on" : "")}
            title={focusMode ? "Exit focus mode (Esc)" : "Focus mode: write full screen"}
            aria-label={focusMode ? "Exit focus mode" : "Focus mode"}
            aria-pressed={focusMode}
            onMouseDown={noop}
            onClick={() => setFocusMode((f) => !f)}
          >
            {focusMode ? "🗗" : "⛶"}
          </button>
          <button
            type="button"
            className={"rte-btn" + (showHelp ? " on" : "")}
            title="Shortcuts & formatting help"
            aria-label="Shortcuts and formatting help"
            aria-pressed={showHelp}
            onMouseDown={noop}
            onClick={() => setShowHelp((v) => !v)}
          >
            ?
          </button>
        </div>
      </div>

      {showHelp && (
        <div className="rte-help">
          <div>
            <h4>Keyboard shortcuts</h4>
            <dl>
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h4>Type it yourself</h4>
            <dl>
              {SYNTAX.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <code>{k}</code>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {findOpen && (
        <div className="rte-find" role="search">
          <div className="rte-find-row">
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                setMatchIndex(0);
                setFindNote(null);
              }}
              onKeyDown={onFindKey}
              placeholder="Find…"
              aria-label="Find text"
            />
            <span className="rte-find-count" aria-live="polite">
              {findQuery ? (matches.length ? `${current + 1} of ${matches.length}` : "No matches") : ""}
            </span>
            <button type="button" className="rte-btn" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}>
              ↑
            </button>
            <button type="button" className="rte-btn" title="Next (Enter)" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}>
              ↓
            </button>
            <button
              type="button"
              className={"rte-btn" + (caseSensitive ? " on" : "")}
              title="Match case"
              aria-label="Match case"
              aria-pressed={caseSensitive}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
            <button
              type="button"
              className={"rte-btn" + (wholeWord ? " on" : "")}
              title="Whole words only"
              aria-label="Whole words only"
              aria-pressed={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
            >
              <u>ab</u>
            </button>
            <button type="button" className="rte-btn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>
              ✕
            </button>
          </div>
          <div className="rte-find-row">
            <input
              value={replaceWith}
              onChange={(e) => setReplaceWith(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  replaceOne();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                }
              }}
              placeholder="Replace with…"
              aria-label="Replace with"
            />
            <button type="button" className="small-btn" disabled={current < 0} onClick={replaceOne}>
              Replace
            </button>
            <button type="button" className="small-btn" disabled={!matches.length} onClick={replaceEverything}>
              Replace all
            </button>
          </div>
          {findNote && <p className="muted small rte-find-note">{findNote}</p>}
        </div>
      )}

      <div className="rte-body">
        {mode === "preview" ? (
          <div className="rte-preview">
            {value.trim() ? (
              <MarkdownView
                source={value}
                onToggleTask={(line) =>
                  commit({ value: toggleTaskLine(value, line), start: 0, end: 0 }, false)
                }
              />
            ) : (
              <p className="muted small">Nothing to preview yet.</p>
            )}
          </div>
        ) : (
          <div className="rte-surface-wrap">
            {findOpen && findQuery && (
              <div ref={backdropRef} className="rte-surface rte-backdrop" aria-hidden="true">
                {renderBackdrop()}
              </div>
            )}
            <textarea
              ref={taRef}
              className="rte-surface rte-textarea"
              value={value}
              onChange={(e) => handleTyping(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={trackSelection}
              onKeyUp={trackSelection}
              onClick={trackSelection}
              placeholder={placeholder}
              maxLength={maxLength}
              rows={minRows}
              aria-label={ariaLabel}
              spellCheck
            />
          </div>
        )}
      </div>

      <div className="rte-status" aria-live="off">
        <span>
          {stats.words} {stats.words === 1 ? "word" : "words"} · {stats.chars.toLocaleString()}
          {maxLength && stats.chars > maxLength * 0.8 ? ` / ${maxLength.toLocaleString()}` : ""} characters
          {stats.readingMinutes ? ` · ${stats.readingMinutes} min read` : ""}
        </span>
        {mode === "write" && (
          <span className="rte-pos">
            Ln {cursor.line}, Col {cursor.col}
          </span>
        )}
      </div>
    </div>
  );
}
