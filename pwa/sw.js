const CACHE_NAME = "vault-os-v0";
const ASSETS = [
  "/pwa/index.html",
  "/pwa/app.js",
  "/pwa/settings.html",
  "/pwa/settings.js",
  "/pwa/vault.js",
  "/pwa/db.js",
  "/pwa/manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
