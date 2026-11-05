import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "https://cipherfilm.orb.local",
    ignoreHTTPSErrors: true,
    // The test container does not trust OrbStack's local CA; Service Workers refuse to register without this.
    browserName: (process.env.BROWSER || "chromium") as "chromium" | "firefox" | "webkit",
    launchOptions: process.env.BROWSER && process.env.BROWSER !== "chromium" ? {} : { args: ["--ignore-certificate-errors"] },
    screenshot: "only-on-failure",
  },
});
