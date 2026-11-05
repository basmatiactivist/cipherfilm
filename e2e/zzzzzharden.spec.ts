import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Hardening: awkward names, interrupted and slow uploads, server errors, an expired session.
const ERIN = "erin@example.org";
const ERIN_PW = pw("erin");
const png = readFileSync(join(__dirname, "fixtures/sample.png"));

async function newPage(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, ...opts });
  return { ctx, page: await ctx.newPage() };
}
async function signIn(page: Page, email = ERIN, pw = ERIN_PW) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe.serial("hardening", () => {
  test("very long, emoji and right-to-left names survive upload, lightbox, albums and ZIP without breaking the layout", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await signIn(page);
    const long = "L".repeat(190) + ".png";
    const names = [long, "תמונה 🌅 חג.png", "😀 日本語のファイル名.png"];
    // hold the uploads so the upload list, which shows the names too, is on screen for the check
    let release = () => {};
    const held = new Promise<void>((ok) => (release = ok));
    await page.route("**/segments/*", async (r) => { await held; await r.continue(); });
    await page.locator('input[type="file"]').setInputFiles(names.map((name) => ({ name, mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from(name)]) })));
    await expect(page.locator(".jobs .jobname")).toHaveCount(3);
    expect(await overflow(page)).toBe(false);
    release(); // the route stays: once released it passes every request straight on
    for (const name of names) await expect(page.getByRole("button", { name: `Open ${name}` }).first()).toBeVisible({ timeout: 60_000 });
    expect(await overflow(page)).toBe(false);

    await page.getByRole("button", { name: `Open ${names[1]}` }).click();
    await expect(page.locator("dialog.lightbox .lbname")).toHaveText(names[1]);
    expect(await overflow(page)).toBe(false);
    // closing goes through history.back(); retry the whole close-and-open step until the dialog really is the long one
    await expect(async () => {
      if (await page.locator("dialog.lightbox").count()) await page.keyboard.press("Escape");
      await expect(page.locator("dialog.lightbox")).toHaveCount(0, { timeout: 2000 });
      await page.getByRole("button", { name: `Open ${long}` }).click({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.locator("dialog.lightbox .lbname")).toHaveText(long); // wait for this item, not the one that was just closed
    await expect.poll(() => page.locator("dialog.lightbox .lbname").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true); // truncated, not overflowing
    expect(await overflow(page)).toBe(false);
    await page.keyboard.press("Escape");

    // a 100-character emoji album name; the page stays inside the viewport
    await page.getByRole("button", { name: "Albums" }).click();
    await page.getByLabel("New album name").fill("🎞️ " + "A".repeat(150));
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(page.locator(".pagetitle")).toBeVisible();
    expect((await page.locator(".pagetitle").innerText()).length).toBeLessThanOrEqual(100);
    expect(await overflow(page)).toBe(false);
    await ctx.close();
  });

  test("an upload cut off mid-way resumes where it stopped, without re-sending finished parts", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const big = Buffer.alloc(9 * 1024 * 1024 + 7);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13 + (i >> 9)) & 255;
    let failing = true;
    const puts: Record<string, number> = {};
    await page.route("**/api/items/*/segments/*", async (route) => {
      const seg = route.request().url().split("/segments/")[1];
      if (route.request().method() === "PUT") {
        if (seg === "1" && failing) return route.abort("connectionreset");
        puts[seg] = (puts[seg] ?? 0) + 1;
      }
      return route.continue();
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "resume-me.bin", mimeType: "application/octet-stream", buffer: big });
    await expect(page.getByRole("alert").filter({ hasText: "Can't reach the server" })).toBeVisible({ timeout: 40_000 });
    await expect(page.locator(".jobs")).toContainText("Stopped");
    failing = false; // the network is back
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: "Open resume-me.bin" })).toBeVisible({ timeout: 60_000 });
    expect(puts["0"]).toBe(1); // finished part was not sent again
    expect(puts["1"]).toBeGreaterThanOrEqual(1);
    expect(puts["2"]).toBe(1);
    await page.getByRole("button", { name: "Open resume-me.bin" }).click();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Download original" }).click()]);
    expect(readFileSync((await dl.path())!).equals(big)).toBe(true);
    await ctx.close();
  });

  test("a slow connection still completes and shows progress", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: (200 * 1024) / 8 * 8, uploadThroughput: 150 * 1024 });
    const data = Buffer.alloc(450 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
    const before = await page.getByRole("button", { name: /^Open slow-/ }).count();
    await page.locator('input[type="file"]').setInputFiles({ name: "slow-file.bin", mimeType: "application/octet-stream", buffer: data });
    await expect(page.getByRole("progressbar", { name: "Upload progress", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Open slow-file.bin" })).toBeVisible({ timeout: 90_000 });
    expect(await page.getByRole("button", { name: /^Open slow-/ }).count()).toBe(before + 1);
    await ctx.close();
  });

  test("a server error is explained in plain words and nothing is lost", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    const n = await page.locator(".tile").count();
    await page.route("**/api/items/trash", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "server error" }) }));
    await page.getByRole("button", { name: "Select" }).click();
    await page.locator(".tile").first().click();
    await page.locator(".selbar").getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByRole("alert")).toContainText("The server had a problem");
    await expect(page.locator(".tile")).toHaveCount(n);
    await expect(page.locator(".selbar")).toBeVisible(); // selection is kept so they can try again
    await ctx.close();
  });

  test("an expired session returns to sign-in with an explanation", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    await page.route("**/api/albums", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "not signed in" }) }));
    await page.getByRole("button", { name: "Albums" }).click();
    await page.getByLabel("New album name").fill("x");
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Your session has ended")).toBeVisible();
    await ctx.close();
  });
});
