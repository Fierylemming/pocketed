// Pocketed service worker: makes the website installable and lets it open
// offline. Notes themselves live in localStorage (the app syncs them), so this
// only caches the app shell. API calls go straight to the network.

const SHELL_CACHE = "pocketed-shell-v5";
const ASSET_CACHE = "pocketed-assets";
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE]);
const SHELL = [
  "/",
  "/index.html",
  "/theme-init.js",
  "/icons/pocketed.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // sync server: network only

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  } else if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    // Only the app itself is the offline start page (not e.g. /privacy.html).
    const path = new URL(req.url).pathname;
    if (res.ok && (path === "/" || path === "/index.html")) cache.put("/index.html", res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match("/index.html")) || Response.error();
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(ASSET_CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
