import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorPicker } from "../src/components/ColorPicker";

// Swatch buttons only — not the ".color-swatch-grid" wrapper.
const swatches = (html: string) =>
  html.match(/class="color-swatch(?: selected)?"/g)?.length ?? 0;

describe("ColorPicker", () => {
  it("offers Google Calendar's palette and names the chosen colour", () => {
    const html = renderToStaticMarkup(
      <ColorPicker value="#039be5" original="#039be5" onChange={() => {}} />,
    );
    expect(swatches(html)).toBe(24);
    expect(html).toContain('aria-label="Peacock"');
    expect(html).toContain('aria-label="Avocado"');
    expect(html).toContain(">Peacock<");
    // Exactly one swatch is marked as the chosen one.
    expect(html.match(/class="color-swatch selected"/g)).toHaveLength(1);
  });

  it("keeps a custom shade from Google's own picker selectable", () => {
    const html = renderToStaticMarkup(
      <ColorPicker value="#123456" original="#123456" onChange={() => {}} />,
    );
    expect(swatches(html)).toBe(25);
    expect(html).toContain('aria-label="Custom"');
    expect(html).toContain(">Custom<");
  });

  it("shows a retired name (old reminders and old app copies) as its Google shade", () => {
    const html = renderToStaticMarkup(<ColorPicker value="sky" onChange={() => {}} />);
    expect(swatches(html)).toBe(24);
    expect(html).toContain('aria-label="Peacock"');
    expect(html.match(/class="color-swatch selected"/g)).toHaveLength(1);
  });

  it("can leave the name out where the surrounding UI already shows it", () => {
    const html = renderToStaticMarkup(
      <ColorPicker value="#d50000" onChange={() => {}} showName={false} />,
    );
    expect(html).not.toContain("color-picker-name");
    expect(swatches(html)).toBe(24);
  });
});
