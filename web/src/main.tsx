import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { captureInstallPrompt } from "./install";
import "./styles.css";

// Must run before the browser fires beforeinstallprompt (which can be early).
captureInstallPrompt();

// The service worker only runs on the built site; the dev server stays uncached.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline caching is a bonus; the app works without it */
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
