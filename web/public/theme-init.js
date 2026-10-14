// Runs before styles and React to avoid flashing the wrong theme on reload.
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("pocketed.v2.theme");
    if (saved === "light" || saved === "dark") preference = saved;
  } catch { /* Storage may be unavailable in private browsing. */ }
  const dark = preference === "dark" || (preference === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#101b2b" : "#f3f6fa");
})();
