import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(__dirname, "../data");

/** Serve ../data at /data during `vite` / `vite preview`. */
function serveRepoData(): Plugin {
  const mime: Record<string, string> = {
    ".json": "application/json; charset=utf-8",
    ".gz": "application/gzip",
  };
  function handler(
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (b?: unknown) => void;
    },
    next: () => void,
  ) {
    const raw = (req.url || "").split("?")[0];
    const rel = decodeURIComponent(raw.replace(/^\/data\/?/, "").replace(/^\/+/, ""));
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) return next();
    const file = path.resolve(dataRoot, rel);
    const rootWithSep = dataRoot.endsWith(path.sep) ? dataRoot : dataRoot + path.sep;
    if ((!file.startsWith(rootWithSep) && file !== dataRoot)
      || !fs.existsSync(file)
      || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    fs.createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
  }
  return {
    name: "serve-repo-data",
    configureServer(server) {
      server.middlewares.use("/data", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/data", handler);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), serveRepoData()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
