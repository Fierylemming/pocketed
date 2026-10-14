import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export const THEME_KEY = "pocketed.v2.theme";
const CHANGE = "pocketed:theme";
export function validTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
function storedTheme(): ThemePreference {
  try { return validTheme(localStorage.getItem(THEME_KEY)); } catch { return "system"; }
}
export function getTheme(): ThemePreference {
  return typeof document === "undefined" ? "system" : validTheme(document.documentElement.dataset.themePreference ?? storedTheme());
}
function applyTheme(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const resolved = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c1014" : "#f4f6f8");
  window.dispatchEvent(new Event(CHANGE));
}
export function setTheme(preference: ThemePreference) {
  try { localStorage.setItem(THEME_KEY, preference); } catch { /* Keep the choice for this visit when storage is blocked. */ }
  applyTheme(preference);
}
/** Apply before React mounts; keep system preference and other tabs in sync. */
export function startTheme(): () => void {
  applyTheme(storedTheme());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystem = () => { if (getTheme() === "system") applyTheme("system"); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) applyTheme(storedTheme());
  };
  media?.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    media?.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}
function subscribe(listener: () => void) {
  window.addEventListener(CHANGE, listener);
  return () => window.removeEventListener(CHANGE, listener);
}
export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, () => "system" as const);
}
