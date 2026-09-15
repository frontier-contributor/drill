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

export default defineConfig({
  plugins: [react(), dropLocalConfig()],
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
