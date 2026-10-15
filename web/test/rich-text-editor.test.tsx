// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCaretVisible, RichTextEditor } from "../src/components/RichTextEditor";

let host: HTMLDivElement;
let root: Root;
let measuredHeight = 240;
let originalScrollHeight: PropertyDescriptor | undefined;

async function renderEditor(value: string, placeholder = "Write…") {
  await act(async () =>
    root.render(
      <RichTextEditor value={value} onChange={() => {}} ariaLabel="Note body" placeholder={placeholder} />,
    ),
  );
  return host.querySelector<HTMLTextAreaElement>("textarea")!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  measuredHeight = 240;
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => measuredHeight,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScrollHeight) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
  vi.unstubAllGlobals();
});

describe("RichTextEditor sizing", () => {
  it("sizes the box to its text, but does not re-measure on unrelated re-renders", async () => {
    const ta = await renderEditor("a long note");
    expect(ta.style.height).toBe("242px");

    // An unrelated re-render (a sync, the clock, a draft being kept) used to
    // collapse and regrow the box, which made the page jump in long notes.
    measuredHeight = 900;
    await renderEditor("a long note", "A different placeholder");
    expect(ta.style.height).toBe("242px");

    await renderEditor("a long note, with more written");
    expect(ta.style.height).toBe("902px");
  });

  it("scrolls a long note's textarea back to a caret that has scrolled out of view", async () => {
    const ta = document.createElement("textarea");
    ta.value = "first line\nsecond line";
    document.body.append(ta);
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(ta, "clientHeight", { configurable: true, value: 100 });
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 500; // caret on the first line, box scrolled far past it
    ensureCaretVisible(ta);
    expect(ta.scrollTop).toBe(0);
    ta.remove();
  });
});
