import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests for the app's plain TypeScript (no React Native runtime): native modules are mocked per test.
export default defineConfig({
  resolve: { alias: { "@crypto": path.resolve(import.meta.dirname, "../web/src/crypto"), "@places": path.resolve(import.meta.dirname, "../web/src/places"), "@cleanup": path.resolve(import.meta.dirname, "../web/src/cleanup"), "libsodium-wrappers-sumo": path.resolve(import.meta.dirname, "../web/node_modules/libsodium-wrappers-sumo") } },
  test: { include: ["src/**/*.test.ts"] },
});
