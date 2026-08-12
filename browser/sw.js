/* Shell cache for browser/ (data gz files use Cache API in js/cache.js). */
const SHELL = "nep-shell-v3";
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
      Promise.all(
        keys
          .filter((k) => k !== SHELL && !k.startsWith("nep-static"))
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.includes("/data/")) return;
  if (!url.pathname.includes("/browser")) return;
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
