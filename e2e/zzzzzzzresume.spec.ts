import { Browser, expect, Page, test } from "@playwright/test";
import { pw } from "./creds";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Uploads that are interrupted: the connection drops, the tab is reloaded, the tab is about to be closed.
const CAROL = "carol@example.org";
const CAROL_PW = pw("carol");
const count = async (page: Page) => ((await (await page.request.get("/api/items")).json()).items as unknown[]).length;

async function signIn(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("E-mail").fill(CAROL);
  await page.getByLabel("Password").fill(CAROL_PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
  return { ctx, page };
}

test.describe.serial("interrupted uploads", () => {
  test("the connection drops: the upload stops, then continues by itself when it is back", async ({ browser }) => {
    const { ctx, page } = await signIn(browser);
    const before = await count(page);
    await ctx.setOffline(true);
    await page.locator('input[type="file"]').setInputFiles({ name: "offline.bin", mimeType: "application/octet-stream", buffer: randomBytes(300_000) });
    await expect(page.locator(".jobs")).toContainText("Stopped", { timeout: 60_000 });
    await expect(page.locator(".jobs")).toContainText("continues by itself");
    await ctx.setOffline(false);
    await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => count(page)).toBe(before + 1);
    await ctx.close();
  });

  test("the tab is reloaded mid-upload: the library says so, and choosing the file again skips the finished parts", async ({ browser }) => {
    mkdirSync("test-results", { recursive: true });
    const file = "test-results/resume-me.bin";
    writeFileSync(file, randomBytes(9 * 1024 * 1024)); // three parts; a file on disk keeps its date, so it is recognised again
    const { ctx, page } = await signIn(browser);
    const before = await count(page);
    await page.route("**/segments/2", (r) => r.abort());
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.locator(".jobs")).toContainText("Stopped", { timeout: 90_000 });
    await page.unroute("**/segments/2");

    await page.reload(); // stays unlocked: the tab keeps the key across a reload (web/src/keep.ts)
    await expect(page.getByText("“resume-me.bin” didn't finish uploading.")).toBeVisible({ timeout: 30_000 });

    const parts: string[] = [];
    page.on("request", (r) => { const m = r.url().match(/\/segments\/(\d+)$/); if (m && r.method() === "PUT") parts.push(m[1]); });
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 60_000 });
    expect(parts).toEqual(["2"]); // parts 0 and 1 were already on the server
    await expect.poll(() => count(page)).toBe(before + 1);
    await expect(page.getByText("didn't finish uploading")).toHaveCount(0);
    await ctx.close();
  });

  test("while files upload, leaving the page asks first", async ({ browser }) => {
    const { ctx, page } = await signIn(browser);
    // Whether the browser then really shows its prompt depends on its own rules (a recent click on the page),
    // which make a real close flaky in CI; the app's part is cancelling beforeunload while files upload.
    const asks = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    expect(await asks()).toBe(false);
    let release = () => {};
    const held = new Promise<void>((ok) => (release = ok));
    await page.route("**/segments/*", async (r) => { await held; await r.continue(); });
    await page.locator('input[type="file"]').setInputFiles({ name: "slow.bin", mimeType: "application/octet-stream", buffer: randomBytes(200_000) });
    await expect(page.locator(".jobs")).toContainText("Keep this page open");
    await expect.poll(asks).toBe(true); // the listener is added right after the list renders
    release();
    await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(asks).toBe(false);
    await ctx.close();
  });
});
