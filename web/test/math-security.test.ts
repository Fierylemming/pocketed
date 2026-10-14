// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import katex from "katex";
import { mathHtml } from "../src/components/MathView";

function fragment(tex: string) {
  const host = document.createElement("div");
  host.innerHTML = mathHtml(katex, tex) ?? "";
  return host;
}

function expectNoActiveContent(host: HTMLElement) {
  expect(host.querySelector("script, iframe, object, embed, img, a, [src], [href]")).toBeNull();
  for (const element of host.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
    }
  }
}

describe("untrusted note maths", () => {
  it.each([
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\href{https://attacker.example/}{click}`,
    String.raw`\includegraphics{https://attacker.example/tracker.png}`,
    String.raw`\htmlData{foo=" onmouseover="alert(1)}{x}`,
    String.raw`\htmlClass{untrusted-class}{x}`,
  ])("does not enable HTML or external resources for %s", (tex) => {
    const host = fragment(tex);
    expectNoActiveContent(host);
    expect(host.querySelector(".untrusted-class, [data-foo]")).toBeNull();
  });

  it("does not inherit a polluted trust option", () => {
    // Regression for GHSA-238p-pmpm-9mq7; restore the prototype before making
    // assertions so this deliberate pollution cannot affect the test runner.
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "trust");
    let html: string | null;
    try {
      Object.defineProperty(Object.prototype, "trust", { value: true, writable: true, configurable: true });
      html = mathHtml(katex, String.raw`\href{javascript:alert(1)}{click}`);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "trust", previous);
      else Reflect.deleteProperty(Object.prototype, "trust");
    }
    const host = document.createElement("div");
    expect(html).toContain("katex");
    host.innerHTML = html ?? "";
    expectNoActiveContent(host);
  });

  it("bounds recursive macro expansion instead of hanging the renderer", () => {
    const host = fragment(String.raw`\def\loop{\loop}\loop`);
    expect(host.querySelector(".katex-error")).not.toBeNull();
    expectNoActiveContent(host);
  });

  it("falls back to the source chip if the renderer fails unexpectedly", () => {
    const failingRenderer = { ...katex, renderToString: () => { throw new Error("Renderer failed"); } };
    expect(mathHtml(failingRenderer, "x^2")).toBeNull();
  });

  it("still renders ordinary mathematical expressions", () => {
    const host = fragment(String.raw`\frac{a}{b} + x_i`);
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.querySelector(".katex-error")).toBeNull();
  });
});
