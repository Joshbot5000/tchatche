// Tchatche offline cache.
// Only ever deletes this app's own old "tchatche-v*" caches: the on-device AI model lives in WebLLM's
// "webllm/*" caches in the same storage and must survive app updates.
const CACHE = "tchatche-v11";
const LIB = "tchatche-lib-webllm-0.2.84";          // 6.5 MB engine, kept across app versions
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(SHELL)),
    caches.open(LIB).then(c => c.match("./webllm.js").then(m => m || c.add("./webllm.js").catch(() => {})))
  ]));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^tchatche-v\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const put = (name, res) => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(name).then(c => c.put(req, copy)); } return res; };
  if (url.origin === location.origin && url.pathname.endsWith("/webllm.js")) {
    e.respondWith(caches.open(LIB).then(c => c.match(req, {ignoreSearch: true}).then(m => m || fetch(req).then(r => put(LIB, r)))));
  } else if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => put(CACHE, r)).catch(() => caches.match(req, {ignoreSearch: true}).then(m => m || caches.match("./index.html"))));
  } else if (url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com") {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => put(CACHE, r))));
  }
});
