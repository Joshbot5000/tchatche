// Tchatche offline cache: app shell network-first (so updates arrive), fonts cache-first.
const CACHE = "tchatche-v5";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const put = res => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, {ignoreSearch: true}).then(m => m || caches.match("./index.html"))));
  } else if (url.hostname === "fonts.gstatic.com" || (url.hostname === "fonts.googleapis.com")) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(put)));
  }
});
