// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemePicker } from "../src/components/ThemePicker";
import { getTheme, setTheme, startTheme, THEME_KEY } from "../src/theme";

let host: HTMLDivElement;
let root: Root;
let stop: (() => void) | undefined;
let dark: boolean;
let systemListeners: Set<() => void>;
function systemTheme(value: boolean) { dark = value; systemListeners.forEach((fn) => fn()); }
function theme() { return document.documentElement.dataset.theme; }
function button(label: string, index = 0) {
  return [...host.querySelectorAll("button")].filter((b) => b.textContent === label)[index];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  document.head.innerHTML = '<meta name="theme-color" content="#f4f6f8">';
  dark = false;
  systemListeners = new Set();
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return dark; },
    addEventListener: (_: string, fn: () => void) => systemListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => systemListeners.delete(fn),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  stop?.(); stop = undefined;
  host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("colour themes", () => {
  it("defaults to System and follows live OS changes", () => {
    stop = startTheme();
    expect(getTheme()).toBe("system"); expect(theme()).toBe("light");
    systemTheme(true);
    expect(theme()).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0c1014");
    systemTheme(false); expect(theme()).toBe("light");
  });

  it("restores saved preferences and ignores OS changes for an explicit choice", () => {
    localStorage.setItem(THEME_KEY, "dark"); stop = startTheme();
    expect(theme()).toBe("dark");
    systemTheme(false); expect(theme()).toBe("dark");
    setTheme("light"); systemTheme(true);
    expect(getTheme()).toBe("light"); expect(theme()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    setTheme("system"); expect(theme()).toBe("dark");
  });

  it("synchronises compact and full controls, with accessible pressed states", () => {
    stop = startTheme();
    act(() => root.render(<><ThemePicker /><ThemePicker compact /></>));
    expect(button("System").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Dark").click());
    expect(theme()).toBe("dark");
    expect(button("Dark", 1).getAttribute("aria-pressed")).toBe("true");
    expect(button("System").getAttribute("aria-pressed")).toBe("false");
    act(() => button("Light", 1).click());
    expect(button("Light").getAttribute("aria-pressed")).toBe("true");
    expect(theme()).toBe("light");
  });

  it("accepts other-tab preference changes and resets to System on storage clear", () => {
    stop = startTheme();
    localStorage.setItem(THEME_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    expect(getTheme()).toBe("dark"); expect(theme()).toBe("dark");
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(getTheme()).toBe("system"); expect(theme()).toBe("light");
  });

  it("falls back safely for invalid saved values", () => {
    localStorage.setItem(THEME_KEY, "not-a-theme"); dark = true;
    stop = startTheme();
    expect(getTheme()).toBe("system"); expect(theme()).toBe("dark");
  });

  it("keeps in-session changes usable when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    stop = startTheme();
    expect(theme()).toBe("light");
    setTheme("dark");
    expect(getTheme()).toBe("dark"); expect(theme()).toBe("dark");
    systemTheme(false); expect(theme()).toBe("dark");
  });

  it("does not require matchMedia, and removes its event listeners", () => {
    vi.stubGlobal("matchMedia", undefined);
    stop = startTheme();
    expect(theme()).toBe("light");
    setTheme("dark"); stop();
    localStorage.setItem(THEME_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }));
    expect(theme()).toBe("dark");
  });
});
