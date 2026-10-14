import { describe, expect, it } from "vitest";
import {
  parseInline,
  parseMarkdown,
  safeHref,
  taskProgress,
  toggleTaskLine,
  toPlainText,
  type Block,
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

  it("reads a pipe table with its alignment row", () => {
    const blocks = parseMarkdown(
      "| Item | Link | Qty |\n| --- | :---: | ---: |\n| card | [site](https://x.y) | **2** |\n| tray |  | 1 |",
    );
    expect(blocks).toHaveLength(1);
    const table = blocks[0]!;
    expect(table.type).toBe("table");
    expect(table).toMatchObject({
      align: [null, "center", "right"],
      header: [
        [{ type: "text", text: "Item" }],
        [{ type: "text", text: "Link" }],
        [{ type: "text", text: "Qty" }],
      ],
    });
    if (table.type !== "table") return;
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![1]![0]).toMatchObject({ type: "link" });
    expect(table.rows[0]![2]![0]).toMatchObject({ type: "strong" });
    // Short rows are padded out to the header's width.
    expect(table.rows[1]).toHaveLength(3);
    expect(table.rows[1]![1]).toEqual([]);
  });

  it("doesn't need outer pipes, and lets cells hold a written \\|", () => {
    const [table] = parseMarkdown("a | b\n--- | ---\nc \\| d | e") as Extract<
      Block,
      { type: "table" }
    >[];
    expect(table.header.map((c) => c[0])).toMatchObject([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    expect(table.rows[0]![0]![0]).toEqual({ type: "text", text: "c | d" });
    expect(table.rows[0]![1]![0]).toEqual({ type: "text", text: "e" });
  });

  it("needs a divider row for a table", () => {
    expect(parseMarkdown("a | b\nc | d").map((b) => b.type)).toEqual(["paragraph"]);
    // A list line isn't a table header either; its divider stays plain text.
    expect(parseMarkdown("- a | b\n--- | ---").map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  it("ends the table at a blank line", () => {
    const blocks = parseMarkdown("a | b\n--- | ---\n1 | 2\n\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["table", "paragraph"]);
  });

  it("reads display maths on its own lines as a block", () => {
    expect(parseMarkdown("$$\nx^2 + y^2\n$$")).toEqual([
      { type: "mathblock", tex: "x^2 + y^2" },
    ]);
    expect(parseMarkdown("before\n$$f(x)$$\nafter")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "mathblock", tex: "f(x)" },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]);
  });
});

describe("maths syntax", () => {
  it("reads $inline$ and $$display$$ maths", () => {
    expect(parseInline("Einstein said $E = mc^2$ once")).toEqual([
      { type: "text", text: "Einstein said " },
      { type: "math", tex: "E = mc^2", display: false },
      { type: "text", text: " once" },
    ]);
    expect(parseInline("$$\\frac{a}{b}$$")).toEqual([
      { type: "math", tex: "\\frac{a}{b}", display: true },
    ]);
  });

  it("leaves money alone", () => {
    for (const s of ["price: $5", "$5 and $10", "it costs $5, saves $6", "$ $", "$x $"]) {
      expect(parseInline(s)).toEqual([{ type: "text", text: s }]);
    }
  });

  it("honours \\$ and keeps maths off across lines", () => {
    expect(parseInline("\\$5 is money")).toEqual([{ type: "text", text: "$5 is money" }]);
    expect(parseInline("$5\nand ten$")).toEqual([{ type: "text", text: "$5\nand ten$" }]);
    // A subscript and an escaped dollar inside the formula both typeset.
    expect(parseInline("$x_{max}$")).toEqual([{ type: "math", tex: "x_{max}", display: false }]);
    expect(parseInline("$a\\$b$")).toEqual([{ type: "math", tex: "a\\$b", display: false }]);
  });

  it("lets maths sit inside bold text in a table cell", () => {
    const [table] = parseMarkdown("| f | v |\n| --- | --- |\n| **$x^2$** | 4 |") as Extract<
      Block,
      { type: "table" }
    >[];
    expect(table.rows[0]![0]![0]).toMatchObject({ type: "strong" });
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

  it("draws tables as aligned columns and keeps maths as its LaTeX", () => {
    expect(toPlainText("a | b\n--- | ---\n1 | 22\n\n$$x^2$$ and $y_1$")).toBe(
      "a  b\n-  --\n1  22\n\nx^2 and y_1",
    );
  });
});
