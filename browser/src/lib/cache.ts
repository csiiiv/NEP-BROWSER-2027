/** Repo base path ('' locally, '/NEP-BROWSER-2027' on project Pages). */
export function detectBase(): string {
  const pathName = location.pathname;
  const marker = "/browser";
  const i = pathName.indexOf(marker);
  if (i >= 0) {
    // /browser or /browser/ or /browser/dist/ or /browser/index.html
    return pathName.slice(0, i);
  }
  let p = pathName;
  if (p.endsWith("/index.html")) p = p.slice(0, -"/index.html".length);
  if (p.endsWith("/")) p = p.slice(0, -1);
  // Built app served from /browser/dist → treat parent as site root segment
  if (p.endsWith("/dist")) p = p.slice(0, -"/dist".length);
  if (p.endsWith("/browser")) return p.slice(0, -"/browser".length);
  return p;
}

const CACHE_NAME = "nep-static-v2";

export async function fetchGzJson(url: string, { bypassCache = false } = {}): Promise<unknown> {
  const cache = await caches.open(CACHE_NAME);
  let res = bypassCache ? null : await cache.match(url);
  if (!res) {
    res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    try {
      await cache.put(url, res.clone());
    } catch {
      /* private mode / quota */
    }
  }
  const buf = await res.arrayBuffer();
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress gzip (DecompressionStream missing).");
  }
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

export async function cacheStats(): Promise<{ entries: number }> {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return { entries: keys.length };
}

export async function clearNepCache(): Promise<void> {
  await caches.delete(CACHE_NAME);
}
