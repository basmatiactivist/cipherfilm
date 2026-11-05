import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  // the release version, the same as the server's (Dockerfile build-arg VERSION); shown under Account
  define: { __APP_VERSION__: JSON.stringify(process.env.VERSION || "dev") },
  build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  // The HEIC decoder lives in its own worker file under /heic/: the server gives that path a CSP that
  // allows eval (libheif's embind glue needs it) but forbids all network access. Every other file keeps the strict CSP.
  worker: { format: "es", rollupOptions: { output: { entryFileNames: (c) => (c.name.startsWith("heic") ? "heic/worker.js" : "workers/[name]-[hash].js") } } },
  test: { environment: "node" },
});
