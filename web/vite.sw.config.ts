import { defineConfig } from "vite";

// Second build: the Service Worker is a single self-contained classic script at /sw.js (no shared chunks).
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: false, target: "es2022", lib: { entry: "src/sw.ts", formats: ["iife"], name: "cfsw", fileName: () => "sw.js" } },
});
