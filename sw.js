// Offline support: every file is cached on first visit. Pages and questions try the network first so
// new cards appear when online, and fall back to the cached copy when offline.
const CACHE = "swipe-cards-v8";
const FILES = ["./", "index.html", "engine.js", "cards.json", "cards-research.json", "manifest.webmanifest", "icon.svg", "icon-192.png",
               "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const fresh = url.pathname.endsWith("/") || /\.(html|js|json)$/.test(url.pathname);
  if (fresh) {
    // no-cache: revalidate with the server; a plain fetch may take the browser's HTTP cache and serve
    // yesterday's engine.js or cards (2026-10-12: a new grading rule did not load until a hard reload).
    event.respondWith(fetch(event.request, { cache: "no-cache" }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return res;
    }).catch(() => caches.match(event.request, { ignoreSearch: true })));
  } else {
    event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request)));
  }
});
