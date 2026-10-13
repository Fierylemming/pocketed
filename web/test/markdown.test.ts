import { describe, expect, it } from "vitest";
import {
  parseInline,
  parseMarkdown,
  safeHref,
  taskProgress,
  toggleTaskLine,
  toPlainText,
  type ListBlock,
} from "../src/markdown";

describe("parseInline", () => {
  it("reads bold, italic, strikethrough, highlight and code", () => {
    expect(parseInline("a **b** *c* ~~d~~ ==e== `f`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "mark", children: [{ type: "text", text: "e" }] },
      { type: "text", text: " " },
      { type: "code", text: "f" },
    ]);
  });

  it("nests styles", () => {
    expect(parseInline("**bold *and italic***")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "bold " },
          { type: "em", children: [{ type: "text", text: "and italic" }] },
        ],
      },
    ]);
  });

  it("leaves ordinary text alone", () => {
    for (const s of ["2 * 3 * 4", "snake_case_name", "a ** b", "price: $5", "**unclosed"]) {
      expect(parseInline(s)).toEqual([{ type: "text", text: s }]);
    }
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([{ type: "text", text: "*not italic*" }]);
  });

  it("makes links, but only safe ones", () => {
    expect(parseInline("[site](https://example.com)")).toEqual([
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "site" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({ type: "text" });
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("mailto:me@example.com")).toBe("mailto:me@example.com");
  });

  it("autolinks bare web addresses without trailing punctuation", () => {
    const nodes = parseInline("see https://example.com/a?b=1.");
    expect(nodes[1]).toMatchObject({ type: "link", href: "https://example.com/a?b=1" });
    expect(nodes[2]).toEqual({ type: "text", text: "." });
  });
});

describe("parseMarkdown", () => {
  it("keeps plain notes as paragraphs with their line breaks", () => {
    expect(parseMarkdown("milk\neggs\n\nbread")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "milk\neggs" }] },
      { type: "paragraph", content: [{ type: "text", text: "bread" }] },
    ]);
  });

  it("reads headings, quotes, dividers and code blocks", () => {
    const blocks = parseMarkdown("# Title\n> quoted\n---\n```\nlet x = **1**\n```");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "quote", "hr", "code"]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    // No formatting inside code blocks.
    expect(blocks[3]).toEqual({ type: "code", text: "let x = **1**" });
  });

  it("builds nested lists and task items with their source lines", () => {
    const [list] = parseMarkdown("- one\n  - [x] sub\n- [ ] two") as [ListBlock];
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]!.children!.items[0]).toMatchObject({ line: 1, task: true, checked: true });
    expect(list.items[1]).toMatchObject({ line: 2, task: true, checked: false });
  });

  it("keeps an ordered list's starting number", () => {
    const [list] = parseMarkdown("3. c\n4. d") as [ListBlock];
    expect(list).toMatchObject({ ordered: true, start: 3 });
  });
});

describe("task helpers", () => {
  const src = "Shopping\n- [ ] milk\n- [x] eggs\n1. [ ] bread";

  it("ticks and unticks a task line", () => {
    expect(toggleTaskLine(src, 1)).toContain("- [x] milk");
    expect(toggleTaskLine(src, 2)).toContain("- [ ] eggs");
    expect(toggleTaskLine(src, 3)).toContain("1. [x] bread");
    // Not a task: unchanged.
    expect(toggleTaskLine(src, 0)).toBe(src);
    expect(toggleTaskLine(src, 99)).toBe(src);
  });

  it("counts task progress", () => {
    expect(taskProgress(src)).toEqual({ done: 1, total: 3 });
  });
});

describe("toPlainText", () => {
  it("drops formatting marks", () => {
    expect(toPlainText("# Plan\n**Buy** [milk](https://x.y)\n- [x] done\n- todo")).toBe(
      "Plan\n\nBuy milk\n\n☑ done\n• todo",
    );
  });
});
