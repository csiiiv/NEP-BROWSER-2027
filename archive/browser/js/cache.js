/** Repo base path ('' locally, '/NEP-BROWSER-2027' on project Pages). */
export function detectBase() {
  const path = location.pathname;
  const marker = "/archive/browser";
  const i = path.indexOf(marker);
  if (i > 0) return path.slice(0, i);
  if (i === 0) return "";
  // Served from docs/ or root copy of the app
  const parts = path.split("/").filter(Boolean);
  if (parts.length && parts[parts.length - 1].endsWith(".html")) parts.pop();
  if (parts[parts.length - 1] === "browser") parts.pop();
  return parts.length ? "/" + parts.join("/") : "";
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
