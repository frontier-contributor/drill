import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/* Vite copies everything in public/ into dist/ verbatim, and that includes
 * public/config.local.json — the file the README tells you to put your API key
 * in. Deploying the built dist/ therefore served the key at /config.local.json
 * to anyone who asked for it. Gitignoring the file stops it reaching the repo
 * and does nothing about the build, so the build has to drop it explicitly.
 * Runtime behaviour is unchanged: config.ts still fetches the path, so the file
 * still works when you place it next to a deployed dist/ yourself. */
function dropLocalConfig() {
  return {
    name: "drill-drop-local-config",
    apply: "build" as const,
    closeBundle() {
      const leaked = path.resolve(__dirname, "dist/config.local.json");
      if (fs.existsSync(leaked)) fs.rmSync(leaked);
    }
  };
}

/* Excalidraw's hand-drawn fonts are fetched at runtime, and left to itself it
 * fetches them from a CDN (esm.run) — a request to a third party every time a
 * whiteboard opens, from an app that otherwise talks only to the inference
 * backend you pointed it at. Serving them ourselves is the whole fix:
 * components/chat/board/excalidraw.ts sets window.EXCALIDRAW_ASSET_PATH to
 * `${BASE_URL}excalidraw/` before the library loads, and this puts the files
 * there in both dev and the build.
 *
 * Xiaolai is left behind deliberately: it is 13MB of the 14MB, it is the CJK
 * fallback, and shipping it would triple the size of a deploy to cover text
 * that falls back to a system font legibly anyway. */
function excalidrawFonts() {
  const source = path.resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const skip = /(^|[\\/])Xiaolai([\\/]|$)/;

  function copyInto(from: string, to: string) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const at = path.join(from, entry.name);
      if (skip.test(at)) continue;
      const out = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(out, { recursive: true });
        copyInto(at, out);
      } else {
        fs.copyFileSync(at, out);
      }
    }
  }

  return {
    name: "drill-excalidraw-fonts",
    configureServer(server: { middlewares: { use: (path: string, fn: unknown) => void } }) {
      server.middlewares.use(
        "/excalidraw/fonts",
        (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b?: unknown) => void; statusCode: number }, next: () => void) => {
          /* Only ever a file under the fonts directory: the URL is resolved and
             then checked to still be inside it, so a "../.." cannot read the
             machine this is running on. */
          const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
          const file = path.resolve(source, rel);
          if (!file.startsWith(source) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
          res.setHeader("Content-Type", file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
          res.setHeader("Cache-Control", "max-age=86400");
          res.end(fs.readFileSync(file));
        }
      );
    },
    closeBundle() {
      if (!fs.existsSync(source)) return;
      const out = path.resolve(__dirname, "dist/excalidraw/fonts");
      fs.mkdirSync(out, { recursive: true });
      copyInto(source, out);
    }
  };
}

export default defineConfig({
  plugins: [react(), dropLocalConfig(), excalidrawFonts()],
  // Honour PORT so several dev servers can run side by side without each one
  // needing its own hardcoded flag. Falls back to Vite's default.
  server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
  /* The file readers are only ever imported on demand, so the dev server
     discovers them the first time a file is attached — and reloads the page to
     bundle them, throwing away the message being written. Bundling them at
     startup avoids that. Development only; the build is unaffected. */
  optimizeDeps: { include: ["pdfjs-dist", "mammoth", "read-excel-file/browser"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
