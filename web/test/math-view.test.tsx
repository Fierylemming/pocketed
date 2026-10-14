import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../src/components/MarkdownView";
import { loadKatex, mathHtml } from "../src/components/MathView";

describe("MarkdownView tables", () => {
  it("renders a table with header, alignment and inline formatting", () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={"Item | Qty\n--- | ---:\n[site](https://x.y) | **2**"} />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("<th><span>Item</span></th>");
    expect(html).toContain('class="md-align-right"');
    expect(html).toContain("<td><a");
    expect(html).toContain('<td class="md-align-right"><strong><span>2</span></strong></td>');
  });
});

describe("MathView", () => {
  it("shows the LaTeX as a chip before KaTeX has loaded", () => {
    const html = renderToStaticMarkup(<MarkdownView source="so $x^2 + y^2$ holds" />);
    expect(html).toContain('class="md-math-tex"');
    expect(html).toContain("x^2 + y^2");
  });

  it("typesets formulas with KaTeX once loaded", async () => {
    const katex = await loadKatex();
    const html = mathHtml(katex, "\\frac{a}{b} + x_i", false);
    expect(html).toContain('class="katex"');
    // Errors render as red source, never throw.
    const bad = mathHtml(katex, "\\thisisnotacommand", false);
    expect(bad).toContain("katex");
    const display = mathHtml(katex, "x^2", true);
    expect(display).toContain("katex-display");
  });
});
