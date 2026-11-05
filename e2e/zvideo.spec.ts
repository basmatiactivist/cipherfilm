import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Runs after the other specs. Chromium ships without H.264/HEVC, so the playable fixture is WebM (VP8, 12 s, 5.7 MB = two segments).
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const ERIN = "erin@example.org";
const ERIN_PW = pw("erin");

const webm = readFileSync(join(__dirname, "fixtures/sample.webm"));
const garbage = Buffer.alloc(300_000);
for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 197 + (i >> 5)) & 255;

async function newPage(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  return { ctx, page };
}

async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}

const video = (page: Page) => page.locator("dialog.lightbox video");
const state = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => ({ ready: v.readyState, time: v.currentTime, dur: v.duration, err: v.error?.code ?? null, src: v.currentSrc, paused: v.paused }));

test.describe.serial("video", () => {
  test("erin joins and uploads a real video and an undecodable one", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(ERIN);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(ERIN_PW);
    await page.getByLabel("Repeat password").fill(ERIN_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "clip.webm", mimeType: "video/webm", buffer: webm },
      { name: "broken.mp4", mimeType: "video/mp4", buffer: garbage },
    ]);
    await expect(page.locator(".tile")).toHaveCount(2, { timeout: 60_000 });
    // the playable video got a poster frame; the broken one falls back to a placeholder
    await expect(page.getByRole("button", { name: "Open clip.webm" }).locator("img")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Open clip.webm" }).locator(".badge")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open broken.mp4" }).locator(".ph")).toContainText("Video");
    appendFileSync("test-results/markers.txt", "Lavf63.1.102\n"); // muxer tag inside the plaintext WebM; the full tag with its dots, since "Lavf" alone turns up by chance in base64 ciphertext
    await ctx.close();
  });

  test("streams through the Service Worker: plays, and seeks into the second segment", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ERIN, ERIN_PW);
    await page.getByRole("button", { name: "Open clip.webm" }).click();
    await expect(video(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await state(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    let st = await state(page);
    expect(st.src).toContain("/sw/stream/");
    expect(st.err).toBeNull();
    expect(st.dur).toBeGreaterThan(11);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await video(page).evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(async () => (await state(page)).time, { timeout: 15_000 }).toBeGreaterThan(0.5);

    // 10.5 s is past the 4 MiB mark, so this needs the second segment
    await video(page).evaluate((v: HTMLVideoElement) => new Promise<void>((res) => { v.addEventListener("seeked", () => res(), { once: true }); v.currentTime = 10.5; }));
    await expect.poll(async () => (await state(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    st = await state(page);
    expect(st.err).toBeNull();
    expect(st.time).toBeGreaterThan(10);
    // and back to the start
    await video(page).evaluate((v: HTMLVideoElement) => new Promise<void>((res) => { v.addEventListener("seeked", () => res(), { once: true }); v.currentTime = 0.2; }));
    expect((await state(page)).err).toBeNull();
    await ctx.close();
  });

  test("falls back to in-memory decryption when no Service Worker is available", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { serviceWorkers: "block" });
    await signIn(page, ERIN, ERIN_PW);
    await page.getByRole("button", { name: "Open clip.webm" }).click();
    await expect.poll(async () => (await state(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const st = await state(page);
    expect(st.src.startsWith("blob:")).toBe(true);
    expect(st.err).toBeNull();
    await ctx.close();
  });

  test("an unplayable video says so and offers the download; the original round-trips", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ERIN, ERIN_PW);
    await page.getByRole("button", { name: "Open broken.mp4" }).click();
    await expect(page.locator(".lbmsg")).toContainText(/can't be played|couldn't be loaded/, { timeout: 30_000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByRole("button", { name: "Download original" }).click()]);
    expect(readFileSync((await dl.path())!).equals(garbage)).toBe(true);

    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Open clip.webm" }).click();
    const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Download original" }).click()]);
    expect(readFileSync((await dl2.path())!).equals(webm)).toBe(true);
    await ctx.close();
  });

  test("signing out clears the worker's keys: the stream URL no longer plays", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ERIN, ERIN_PW);
    const id: string = await page.evaluate(async () => (await (await fetch("/api/items")).json()).items.find((i: any) => i.kind === "video").id);
    await page.getByRole("button", { name: "Open clip.webm" }).click();
    await expect.poll(async () => (await state(page)).ready, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Escape");
    await openMenuItem(page, "Sign out");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const status = await page.evaluate(async (i) => (await fetch(`/sw/stream/${i}`, { headers: { Range: "bytes=0-9" } })).status, id);
    expect(status).toBe(404);
    await ctx.close();
  });

  test("a tampered segment is refused: nothing plays and the user is told", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { serviceWorkers: "block" });
    await signIn(page, ERIN, ERIN_PW);
    await page.route("**/api/items/*/segments/0", async (route) => {
      const res = await route.fetch();
      const body = Buffer.from(await res.body());
      body[body.length >> 1] ^= 1; // flip one bit in the middle of the ciphertext
      await route.fulfill({ response: res, body });
    });
    await page.getByRole("button", { name: "Open clip.webm" }).click();
    await expect(page.locator(".lbmsg")).toContainText(/couldn't be loaded or verified/, { timeout: 30_000 });
    await expect(video(page)).toHaveCount(0);
    await ctx.close();
  });
});
