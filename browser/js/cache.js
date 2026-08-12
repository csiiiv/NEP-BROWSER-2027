/** Repo base path ('' locally, '/NEP-BROWSER-2027' on project Pages). */
export function detectBase() {
  const path = location.pathname;
  const marker = "/browser";
  const i = path.indexOf(marker);
  if (i >= 0) return path.slice(0, i);
  // Fallback if ever served from elsewhere
  let p = path;
  if (p.endsWith("/index.html")) p = p.slice(0, -"/index.html".length);
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const CACHE_NAME = "nep-static-v1";

export async function fetchGzJson(url, { bypassCache = false } = {}) {
  const cache = await caches.open(CACHE_NAME);
  let res = bypassCache ? null : await cache.match(url);
  if (!res) {
    res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    // Store raw gzip bytes
    try {
      await cache.put(url, res.clone());
    } catch (_) {
      /* private mode / quota */
    }
  }
  const buf = await res.arrayBuffer();
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip (DecompressionStream missing).");
  }
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

export async function cacheStats() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return { entries: keys.length };
}

export async function clearNepCache() {
  await caches.delete(CACHE_NAME);
}
