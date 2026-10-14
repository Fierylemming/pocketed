import { useEffect, useMemo, useState } from "react";
import "katex/dist/katex.min.css";

type Katex = typeof import("katex").default;

/**
 * Maths written as LaTeX ($x^2$ inline, $$…$$ for display) is typeset with
 * KaTeX. The library is a sizeable download, so it's chunk-loaded the first
 * time a note actually contains maths; until it arrives (or for the static
 * markup) the formula shows as its LaTeX source in a code chip.
 */

let katexPromise: Promise<Katex> | null = null;
let katexModule: Katex | null = null;

/** Starts (or reuses) the one-time load of the KaTeX chunk. */
export function loadKatex(): Promise<Katex> {
  katexPromise ??= import("katex").then((m) => {
    katexModule = m.default;
    return m.default;
  });
  return katexPromise;
}

function useKatex(): Katex | null {
  const [mod, setMod] = useState<Katex | null>(katexModule);
  useEffect(() => {
    if (katexModule) return;
    let live = true;
    void loadKatex().then((m) => {
      if (live) setMod(m);
    }).catch(() => {
      // An unavailable lazy chunk (e.g. offline) leaves readable LaTeX in place.
    });
    return () => {
      live = false;
    };
  }, []);
  return mod;
}

/** KaTeX's HTML for a formula, or null while the library hasn't loaded. */
export function mathHtml(katex: Katex | null, tex: string, display?: boolean): string | null {
  if (!katex) return null;
  try {
    return katex.renderToString(tex, {
      displayMode: !!display,
      throwOnError: false,
      strict: false,
      // Notes and imported assignments are untrusted input. Never enable HTML,
      // links, or external resources through LaTeX commands.
      trust: false,
      maxExpand: 1000,
      maxSize: 20,
    });
  } catch {
    // Keep the note usable even if malformed input triggers a non-parse error.
    return null;
  }
}

export function MathSpan({ tex, display }: { tex: string; display?: boolean }) {
  const katex = useKatex();
  const html = useMemo(() => mathHtml(katex, tex, display), [katex, tex, display]);
  if (!html) return <code className="md-math-tex">{tex}</code>;
  return (
    <span
      className={"md-math" + (display ? " md-math-display" : "")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
