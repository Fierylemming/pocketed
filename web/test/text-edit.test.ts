import { describe, expect, it } from "vitest";
import {
  continueList,
  cursorPosition,
  EditHistory,
  findMatches,
  indentLines,
  inListItem,
  insertCodeBlock,
  insertLink,
  replaceAll,
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
