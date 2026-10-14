import { describe, expect, it } from "vitest";
import {
  continueList,
  continueTable,
  cursorPosition,
  EditHistory,
  findMatches,
  indentLines,
  inListItem,
  insertCodeBlock,
  insertLink,
  insertMath,
  insertMathBlock,
  insertTable,
  replaceAll,
  tableCellNav,
  textStats,
  toggleHeading,
  toggleLineFormat,
  toggleWrap,
  type EditState,
} from "../src/text-edit";

/** Writes a state as text with [ ] around the selection, or | for a cursor. */
const show = (s: EditState) =>
  s.start === s.end
    ? s.value.slice(0, s.start) + "|" + s.value.slice(s.start)
    : s.value.slice(0, s.start) + "[" + s.value.slice(s.start, s.end) + "]" + s.value.slice(s.end);

/** The reverse of `show`. */
const at = (marked: string): EditState => {
  const cur = marked.indexOf("|");
  if (cur >= 0) return { value: marked.replace("|", ""), start: cur, end: cur };
  const a = marked.indexOf("[");
  const b = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start: a, end: b };
};

describe("toggleWrap", () => {
  it("wraps and unwraps the selection", () => {
    const bold = toggleWrap(at("say [hello] now"), "**");
    expect(show(bold)).toBe("say **[hello]** now");
    expect(show(toggleWrap(bold, "**"))).toBe("say [hello] now");
  });

  it("unwraps when the marks are inside the selection", () => {
    expect(show(toggleWrap(at("[**hi**]"), "**"))).toBe("[hi]");
  });

  it("adds italics to bold text instead of removing the bold", () => {
    const both = toggleWrap(at("**[word]**"), "*");
    expect(show(both)).toBe("***[word]***");
    expect(show(toggleWrap(both, "*"))).toBe("**[word]**");
    expect(show(toggleWrap(both, "**"))).toBe("*[word]*");
    expect(show(toggleWrap(at("[**word**]"), "*"))).toBe("*[**word**]*");
  });

  it("keeps spaces outside the marks", () => {
    expect(show(toggleWrap(at("a[ word ]b"), "*"))).toBe("a *[word]* b");
  });

  it("inserts a selected placeholder when nothing is selected", () => {
    expect(show(toggleWrap(at("x |"), "**", "**", "bold"))).toBe("x **[bold]**");
  });
});

describe("line formats", () => {
  it("makes a bulleted list and back", () => {
    const list = toggleLineFormat(at("[a\nb]"), "bullet");
    expect(list.value).toBe("- a\n- b");
    expect(toggleLineFormat(list, "bullet").value).toBe("a\nb");
  });

  it("numbers lines and swaps one list kind for another", () => {
    expect(toggleLineFormat(at("[- a\n- b]"), "number").value).toBe("1. a\n2. b");
    expect(toggleLineFormat(at("[1. a\n2. b]"), "task").value).toBe("- [ ] a\n- [ ] b");
  });

  it("keeps the cursor beside its text", () => {
    expect(show(toggleLineFormat(at("ab|c"), "task"))).toBe("- [ ] ab|c");
  });

  it("toggles headings", () => {
    expect(toggleHeading(at("Ti|tle"), 2).value).toBe("## Title");
    expect(toggleHeading(at("## Ti|tle"), 2).value).toBe("Title");
    expect(toggleHeading(at("## Ti|tle"), 1).value).toBe("# Title");
  });

  it("indents and outdents", () => {
    expect(indentLines(at("[- a\n- b]")).value).toBe("  - a\n  - b");
    expect(indentLines(at("  - a|"), true).value).toBe("- a");
  });

  it("knows when the cursor is in a list item", () => {
    expect(inListItem(at("- it|em"))).toBe(true);
    expect(inListItem(at("plain|"))).toBe(false);
  });
});

describe("continueList", () => {
  it("starts the next item", () => {
    expect(show(continueList(at("- milk|"))!)).toBe("- milk\n- |");
    expect(show(continueList(at("9. nine|"))!)).toBe("9. nine\n10. |");
    expect(show(continueList(at("- [x] done|"))!)).toBe("- [x] done\n- [ ] |");
    expect(show(continueList(at("> quote|"))!)).toBe("> quote\n> |");
  });

  it("ends the list on an empty item", () => {
    expect(show(continueList(at("- a\n- |"))!)).toBe("- a\n|");
  });

  it("does nothing outside lists", () => {
    expect(continueList(at("plain|"))).toBeNull();
  });
});

describe("links and blocks", () => {
  it("links selected text", () => {
    expect(show(insertLink(at("[docs]")))).toBe("[docs]([https://])");
    expect(insertLink(at("[docs]"), "https://a.b").value).toBe("[docs](https://a.b)");
  });

  it("wraps lines in a code block on lines of their own", () => {
    expect(insertCodeBlock(at("x [code] y")).value).toBe("```\nx code y\n```");
  });
});

describe("find & replace", () => {
  it("finds matches with options", () => {
    expect(findMatches("Cat cat concat", "cat")).toEqual([[0, 3], [4, 7], [11, 14]]);
    expect(findMatches("Cat cat concat", "cat", { caseSensitive: true })).toEqual([[4, 7], [11, 14]]);
    expect(findMatches("Cat cat concat", "cat", { wholeWord: true })).toEqual([[0, 3], [4, 7]]);
    expect(findMatches("a.b", ".")).toEqual([[1, 2]]);
  });

  it("replaces every match", () => {
    expect(replaceAll("one two one", "one", "1")).toEqual({ value: "1 two 1", count: 2 });
    expect(replaceAll("x", "", "y")).toEqual({ value: "x", count: 0 });
    // $ in the replacement is literal.
    expect(replaceAll("a", "a", "$&$&").value).toBe("$&$&");
  });
});

describe("stats", () => {
  it("counts words, characters and reading time", () => {
    expect(textStats("")).toEqual({ words: 0, chars: 0, lines: 0, readingMinutes: 0 });
    expect(textStats("one two\nthree")).toMatchObject({ words: 3, lines: 2, readingMinutes: 1 });
    // Formatting marks aren't words.
    expect(textStats("# Plan\n- [ ] **one**\n- [x] two\n---").words).toBe(3);
  });

  it("gives the cursor's line and column", () => {
    expect(cursorPosition("ab\ncd", 4)).toEqual({ line: 2, col: 2 });
  });
});

describe("EditHistory", () => {
  const s = (value: string): EditState => ({ value, start: value.length, end: value.length });

  it("groups quick typing into one undo step", () => {
    const h = new EditHistory();
    h.record(s(""), "type", 0);
    h.record(s("a"), "type", 100);
    h.record(s("ab"), "type", 200);
    expect(h.undo(s("abc"))!.value).toBe("");
    expect(h.canUndo).toBe(false);
  });

  it("keeps actions as separate steps and supports redo", () => {
    const h = new EditHistory();
    h.record(s("a"), "type", 0);
    h.record(s("ab"), "action", 100);
    expect(h.undo(s("**ab**"))!.value).toBe("ab");
    expect(h.undo(s("ab"))!.value).toBe("a");
    expect(h.redo(s("a"))!.value).toBe("ab");
    expect(h.redo(s("ab"))!.value).toBe("**ab**");
    expect(h.canRedo).toBe(false);
  });

  it("drops redo after a new change", () => {
    const h = new EditHistory();
    h.record(s("a"), "action", 0);
    h.undo(s("b"));
    h.record(s("a"), "action", 10);
    expect(h.canRedo).toBe(false);
  });
});

describe("tables", () => {
  const T = "| a | b |\n| --- | --- |\n| c | d |";
  /** A one-character selection over `ch` inside T. */
  const inCell = (ch: string): EditState => {
    const p = T.indexOf(ch);
    return { value: T, start: p, end: p + 1 };
  };

  it("inserts a starter table with its first header cell selected", () => {
    const s = insertTable(at("write |"));
    expect(s.value).toBe("write \n| Column A | Column B |\n| --- | --- |\n|  |  |\n|  |  |");
    expect(show(s)).toBe("write \n| [Column A] | Column B |\n| --- | --- |\n|  |  |\n|  |  |");
  });

  it("turns selected lines into rows, the first into the header", () => {
    expect(insertTable(at("Team\n[Alice\nBob\nCarol]")).value).toBe(
      "Team\n| Alice |\n| --- |\n| Bob |\n| Carol |",
    );
  });

  it("splits a single selected line on pipes into header columns", () => {
    const s = insertTable({ value: "Name | Rank", start: 0, end: 11 });
    expect(s.value).toBe("| Name | Rank |\n| --- | --- |\n|   |   |");
    expect(show(s)).toBe("| [Name] | Rank |\n| --- | --- |\n|   |   |");
  });

  it("tabs between cells, wrapping around the table", () => {
    expect(show(tableCellNav(inCell("a"), 1)!)).toBe(
      "| a | [b] |\n| --- | --- |\n| c | d |",
    );
    expect(show(tableCellNav(inCell("d"), 1)!)).toBe(
      "| [a] | b |\n| --- | --- |\n| c | d |",
    );
    expect(show(tableCellNav(inCell("a"), -1)!)).toBe(
      "| a | b |\n| --- | --- |\n| c | [d] |",
    );
  });

  it("skips the divider row and ignores text that isn't a table", () => {
    // Cursor in the divider's dashes: Tab lands in the first body cell.
    const divider = T.indexOf("---") + 1;
    expect(show(tableCellNav({ value: T, start: divider, end: divider + 1 }, 1)!)).toBe(
      "| a | b |\n| --- | --- |\n| [c] | d |",
    );
    expect(tableCellNav({ value: "just a | sentence", start: 9, end: 9 }, 1)).toBeNull();
    // Pipes without a divider aren't a table either.
    expect(tableCellNav({ value: "x | y\nz | w", start: 0, end: 0 }, 1)).toBeNull();
  });

  it("continues a table with an empty row, cursor in its first cell", () => {
    const p = T.indexOf("c") + 1; // a bare cursor just after the c
    expect(show(continueTable({ value: T, start: p, end: p })!)).toBe(
      "| a | b |\n| --- | --- |\n| c | d |\n| |  |   |",
    );
  });

  it("ends the table when Enter hits an empty row", () => {
    const src = "| a | b |\n| --- | --- |\n|   |   |";
    // The empty bottom row's first cell.
    const s = continueTable({ value: src, start: 26, end: 26 });
    expect(s!.value).toBe("| a | b |\n| --- | --- |");
    expect(s!.start).toBe(23);
  });
});

describe("maths", () => {
  it("wraps the selection in $…$, and unwraps it again", () => {
    const s = insertMath(at("say [E = mc^2] loudly"));
    expect(show(s)).toBe("say $[E = mc^2]$ loudly");
    expect(show(insertMath(s))).toBe("say [E = mc^2] loudly");
    // A fresh cursor inserts a formula to edit.
    expect(show(insertMath(at("x |")))).toBe("x $[x^2]$");
  });

  it("puts the selection into a $$ block, or inserts a sample", () => {
    const s = insertMathBlock(at("sum:\n[a^2 + b^2 = c^2]"));
    expect(s.value).toBe("sum:\n$$\na^2 + b^2 = c^2\n$$");
    const fresh = insertMathBlock(at("|"));
    expect(fresh.value).toBe("$$\n\\frac{a}{b}\n$$");
    expect(show(fresh)).toBe("$$\n[\\frac{a}{b}]\n$$");
  });
});
