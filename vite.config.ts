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

/* The entry chunk is what the review loop — the thing opened every day —
 * waits for before it can draw. CONTRIBUTING used to ask you to check its size
 * by eye after a build, and by the time anyone did it had doubled: chat's
 * provider was imported from App.tsx, and the agent loop, drawing, video and
 * the file wire came in behind it. A rule nobody is made to read is not a
 * rule, so the build holds this one.
 *
 * Over budget, the build fails and names the largest modules in the chunk,
 * which is almost always enough to see what was imported from the wrong side
 * of a lazy boundary. Raise the number only on purpose.
 *
 * ENTRY_REPORT=1 prints the same list on a build that passes. */
const ENTRY_BUDGET_KB = 430;
const NL = String.fromCharCode(10);

function entryBudget() {
  return {
    name: "drill-entry-budget",
    apply: "build" as const,
    generateBundle(
      this: { error: (msg: string) => never },
      _opts: unknown,
      bundle: Record<string, { type: string; isEntry?: boolean; code?: string; modules?: Record<string, { renderedLength: number }> }>
    ) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry || !chunk.code) continue;
        const kb = chunk.code.length / 1000;
        const over = kb > ENTRY_BUDGET_KB;
        if (!over && !process.env.ENTRY_REPORT) continue;
        const top = Object.entries(chunk.modules || {})
          .sort((a, b) => b[1].renderedLength - a[1].renderedLength)
          .slice(0, 15)
          .map(([id, m]) => "  " + String(Math.round(m.renderedLength / 1000)).padStart(4) + " kB  " + path.relative(__dirname, id.split("?")[0]))
          .join(NL);
        const line = name + " is " + kb.toFixed(0) + " kB; the budget is " + ENTRY_BUDGET_KB + " kB.";
        if (over) {
          this.error(
            line + NL + "Something the review loop does not need is being imported eagerly. Largest modules in the chunk (before minifying):" + NL + top
          );
        }
        console.log(NL + line + NL + top + NL);
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), dropLocalConfig(), excalidrawFonts(), entryBudget()],
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
