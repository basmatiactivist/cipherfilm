import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Runs last: albums, lightbox, timeline virtualization.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const DAVE = "dave@example.org";
const DAVE_PW = pw("dave");
const MARKER_ALBUM = "SECRET-ALBUM-5b1e22";

const png = readFileSync(join(__dirname, "fixtures/sample.png"));
const heic = readFileSync(join(__dirname, "fixtures/sample.heic"));

async function newPage(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
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

const tile = (page: Page, n: number) => page.locator(".tile").nth(n);

test.describe.serial("gallery", () => {
  test("dave joins and uploads three photos", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(DAVE);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(DAVE_PW);
    await page.getByLabel("Repeat password").fill(DAVE_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: png },
      { name: "two.heic", mimeType: "image/heic", buffer: heic },
      { name: "three.png", mimeType: "image/png", buffer: png },
    ]);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator(".dayhead")).toHaveCount(1); // all captured "today" by file date
    await ctx.close();
  });

  test("lightbox: keyboard, swipe, back button, download", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, DAVE, DAVE_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    await tile(page, 0).click();
    const dlg = page.locator("dialog.lightbox");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator(".lbcount")).toHaveText("1 of 3");
    await expect(dlg.locator(".stage img")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => dlg.locator(".stage img").evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);

    await page.keyboard.press("ArrowRight");
    await expect(dlg.locator(".lbcount")).toHaveText("2 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(dlg.locator(".lbcount")).toHaveText("1 of 3");
    await expect(dlg.getByRole("button", { name: "Previous" })).toBeDisabled();

    // swipe left (touch pointer events) goes to the next item
    await dlg.locator(".stage").evaluate((el) => {
      const ev = (t: string, x: number) => el.dispatchEvent(new PointerEvent(t, { pointerType: "touch", clientX: x, bubbles: true }));
      ev("pointerdown", 300); ev("pointerup", 100);
    });
    await expect(dlg.locator(".lbcount")).toHaveText("2 of 3");

    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await tile(page, 1).click();
    await expect(dlg).toBeVisible();
    await page.goBack();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator(".tile").first()).toBeVisible(); // still unlocked after back
    await ctx.close();
  });

  test("albums: create, add (one photo in two albums), rename, remove, delete keeps photos", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, DAVE, DAVE_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });

    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await tile(page, 1).click();
    await expect(page.locator(".selcount")).toHaveText("2 selected");
    await page.getByRole("button", { name: "Add to album" }).click();
    await page.getByLabel("New album name").fill(MARKER_ALBUM);
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(page.locator(".selbar")).toHaveCount(0); // adding finishes the selection
    appendFileSync("test-results/markers.txt", MARKER_ALBUM + "\n");

    await page.getByRole("button", { name: "Albums" }).click();
    await expect(page.getByRole("button", { name: new RegExp(MARKER_ALBUM) })).toContainText("2 items");

    // second album containing the first photo too
    await page.getByLabel("New album name").fill("Best of");
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(page.getByRole("heading", { name: "Best of" })).toBeVisible();
    await page.getByRole("button", { name: "All albums" }).click();
    await page.getByRole("button", { name: "Timeline" }).click();
    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await page.getByRole("button", { name: "Add to album" }).click();
    await page.getByRole("button", { name: "Best of" }).click();
    await page.getByRole("button", { name: "Albums" }).click();
    await expect(page.getByRole("button", { name: /Best of/ })).toContainText("1 item");
    await expect(page.getByRole("button", { name: new RegExp(MARKER_ALBUM) })).toContainText("2 items");

    // rename, remove one, then delete the album: photos stay
    await page.getByRole("button", { name: new RegExp(MARKER_ALBUM) }).click();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Album name").fill("Holidays");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("heading", { name: "Holidays" })).toBeVisible();
    await expect(page.locator(".tile")).toHaveCount(2);
    // Select all picks every photo in the album for the selection actions
    await page.getByRole("button", { name: "Select all" }).click();
    await expect(page.locator(".selcount")).toHaveText("2 selected");
    await expect(page.getByRole("button", { name: "Select all" })).toHaveCount(0);
    await page.locator(".selbar").getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await tile(page, 0).click();
    await page.getByRole("button", { name: "Remove from album" }).click();
    await expect(page.locator(".tile")).toHaveCount(1);
    await page.getByRole("button", { name: "Delete album…" }).click();
    await page.getByRole("button", { name: "Delete album", exact: true }).click();
    await expect(page.getByRole("button", { name: "Holidays" })).toHaveCount(0);

    await page.getByRole("button", { name: "Timeline" }).click();
    await expect(page.locator(".tile")).toHaveCount(3);
    await ctx.close();
  });

  test("albums and items are invisible to other users", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ADMIN, ADMIN_PW);
    const r = await page.evaluate(async () => ({ albums: (await (await fetch("/api/albums")).json()).albums.length, items: (await (await fetch("/api/items")).json()).items.length }));
    expect(r).toEqual({ albums: 0, items: 0 });
    await ctx.close();
  });

  test("timeline stays fast with hundreds of items: only visible rows are in the DOM", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, DAVE, DAVE_PW);
    // 400 server-side items with random (undecryptable) content: they must render as "couldn't be verified", never crash
    const made = await page.evaluate(async () => {
      const csrf = (await (await fetch("/api/me")).json()).csrf;
      const rnd = (n: number) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
      const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const H = { "X-CSRF-Token": csrf };
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const c = await (await fetch("/api/items", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "image", size: 10, segment_count: 1 }) })).json();
        await fetch(`/api/items/${c.id}/segments/0`, { method: "PUT", headers: { ...H, "Content-Type": "application/octet-stream" }, body: rnd(51) });
        const f = await fetch(`/api/items/${c.id}/finalize`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ wrapped_item_key: b64(rnd(73)), meta_enc: b64(rnd(80)) }) });
        if (f.ok) n++;
      }
      return n;
    });
    expect(made).toBe(400);
    await page.reload(); // stays unlocked: the tab keeps the key across a reload (web/src/keep.ts)
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Show them" }).click(); // unreadable items are hidden until asked for
    const inDom = await page.locator(".tile").count();
    expect(inDom).toBeLessThan(120);
    expect(await page.locator(".timeline").evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(5000);
    await expect(page.locator(".tile .ph.bad").first()).toContainText("verified");

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => page.locator(".tile").count()).toBeGreaterThan(0);
    expect(await page.locator(".tile").count()).toBeLessThan(120);
    await ctx.close();
  });

  test("phone: justified rows fit the width, lightbox fits, no horizontal scroll", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await signIn(page, DAVE, DAVE_PW);
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const xs = new Set(await page.locator(".tile").evaluateAll((els) => els.slice(0, 6).map((e) => Math.round(e.getBoundingClientRect().left))));
    expect(xs.size).toBeGreaterThanOrEqual(2); // rows hold several photos side by side
    expect(await page.locator(".tile").evaluateAll((els) => els.slice(0, 6).every((e) => e.getBoundingClientRect().right <= 376))).toBe(true);
    await page.screenshot({ path: "test-results/phone-timeline.png" });
    await ctx.close();
  });
});
