// Responsive UI scaling.
//
// Every size in the stylesheet is in rem, and the root font size is
// 16px × --scale. --scale follows the screen's *short* side, so a phone reads
// the same in portrait and landscape, and a tiny phone shrinks the whole UI
// (instead of letting cards overflow). Tablets and desktops use 1 (a fluid
// layout takes the extra width). The user can nudge the size in Settings.

export type TextSize = "small" | "default" | "large";

const TEXT_KEY = "pocketed.v2.textSize";
/** Width of the phone the design was tuned on (a common 390px-wide phone). */
export const REFERENCE_WIDTH = 390;
/** At or above this short side we treat the device as a tablet/desktop. */
export const TABLET_MIN = 768;
export const MIN_BASE = 0.82;
export const MAX_BASE = 1.15;

const TEXT_MULT: Record<TextSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.18,
};

export function getTextSize(): TextSize {
  try {
    const v = localStorage.getItem(TEXT_KEY);
    return v === "small" || v === "large" ? v : "default";
  } catch {
    return "default";
  }
}

export function setTextSize(size: TextSize): void {
  try {
    localStorage.setItem(TEXT_KEY, size);
  } catch {
    /* storage blocked: the choice only lasts this visit */
  }
  applyScale();
}

/** Pure: the scale factor for a viewport. Exported for tests. */
export function computeScale(
  width: number,
  height: number,
  textSize: TextSize = "default",
): number {
  const short = Math.max(1, Math.min(width, height));
  const base =
    short >= TABLET_MIN
      ? 1
      : Math.min(MAX_BASE, Math.max(MIN_BASE, short / REFERENCE_WIDTH));
  return round3(base * TEXT_MULT[textSize]);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Recomputes --scale on <html>. Safe to call any time. */
export function applyScale(): void {
  if (typeof window === "undefined") return;
  const vv = window.visualViewport;
  const w = vv?.width ?? window.innerWidth;
  const h = vv?.height ?? window.innerHeight;
  const scale = computeScale(w, h, getTextSize());
  document.documentElement.style.setProperty("--scale", String(scale));
}

/** Keeps --scale in step with rotation, window resizes and the on-screen keyboard. */
export function startScaling(): () => void {
  applyScale();
  window.addEventListener("resize", applyScale);
  window.addEventListener("orientationchange", applyScale);
  window.visualViewport?.addEventListener("resize", applyScale);
  return () => {
    window.removeEventListener("resize", applyScale);
    window.removeEventListener("orientationchange", applyScale);
    window.visualViewport?.removeEventListener("resize", applyScale);
  };
}
