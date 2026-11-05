import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: /.*\.check\.ts/, timeout: 90_000, workers: 1, reporter: "list",
  use: { baseURL: process.env.BASE_URL ?? "https://cipherfilm.orb.local", ignoreHTTPSErrors: true, launchOptions: { args: ["--ignore-certificate-errors"] }, screenshot: "only-on-failure" },
});
