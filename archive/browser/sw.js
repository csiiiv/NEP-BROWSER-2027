/* Shell cache for the static browser (data files use Cache API in js/cache.js). */
const SHELL = "nep-shell-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./js/app.js",
  "./js/cache.js",
  "./js/data.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && !k.startsWith("nep-static")).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Only shell; gz data is handled by page Cache API
  if (!url.pathname.includes("/archive/browser")) return;
  if (url.pathname.includes("/data/")) return;
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    }),
  );
});
