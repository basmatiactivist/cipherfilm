import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Runs after auth.spec.ts (same stack, admin already exists).
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const CAROL = "carol@example.org";
const CAROL_PW = pw("carol");

const MARKER_NAME = "SECRET-NAME-7f3a91";
const MARKER_EXIF = "SECRET-EXIF-c20d44";

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("[browser]", m.text()); });
  return { ctx, page };
}

async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}

/** A real JPEG made in the browser, with a COM segment carrying a marker string, like metadata would. */
async function makeJpeg(page: Page): Promise<Buffer> {
  const bytes: number[] = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 120;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 200, 120);
    grad.addColorStop(0, "#c4122f"); grad.addColorStop(1, "#17428f");
    g.fillStyle = grad; g.fillRect(0, 0, 200, 120);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const jpg = Buffer.from(bytes);
  const text = Buffer.from(MARKER_EXIF);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 255]), text]);
  return Buffer.concat([jpg.subarray(0, 2), com, jpg.subarray(2)]);
}

let jpeg: Buffer;
const heic = readFileSync(join(__dirname, "fixtures/sample.heic"));
const png = readFileSync(join(__dirname, "fixtures/sample.png"));
// 9 MiB: three 4 MiB segments, the last one short
const video = Buffer.alloc(9 * 1024 * 1024 + 123);
for (let i = 0; i < video.length; i++) video[i] = (i * 31 + (i >> 8)) & 255;

test.describe.serial("library", () => {
  test("admin invites carol, carol joins", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(CAROL);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const c = await newPage(browser);
    await c.page.goto(link);
    await c.page.getByLabel("Password", { exact: true }).fill(CAROL_PW);
    await c.page.getByLabel("Repeat password").fill(CAROL_PW);
    await c.page.getByRole("button", { name: "Create account" }).click();
    await c.page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await c.page.getByRole("button", { name: "Continue" }).click();
    await expect(c.page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
    await c.ctx.close();
  });

  test("upload photos, HEIC and a multi-segment video; thumbnails decrypt; originals round-trip", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, CAROL, CAROL_PW);
    jpeg = await makeJpeg(page);

    await page.locator('input[type="file"]').setInputFiles([
      { name: `${MARKER_NAME}.jpg`, mimeType: "image/jpeg", buffer: jpeg },
      { name: "phone.heic", mimeType: "image/heic", buffer: heic },
      { name: "plain.png", mimeType: "image/png", buffer: png },
      { name: "holiday.mp4", mimeType: "video/mp4", buffer: video },
    ]);
    const tiles = page.locator(".tile");
    await expect(tiles).toHaveCount(4, { timeout: 90_000 });
    await expect(page.locator(".jobs")).toHaveCount(0);

    // every image tile (JPEG, HEIC via WASM, PNG) shows a decrypted, decodable thumbnail
    const imgs = page.locator(".tile img");
    await expect(imgs).toHaveCount(3, { timeout: 30_000 });
    for (const img of await imgs.all()) {
      await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
    }
    await expect(page.locator(".tile .ph", { hasText: "Video" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Open ${MARKER_NAME}.jpg` })).toBeVisible();

    // download originals and compare bytes
    for (const [name, buf] of [[`${MARKER_NAME}.jpg`, jpeg], ["phone.heic", heic], ["holiday.mp4", video]] as const) {
      await page.getByRole("button", { name: `Open ${name}` }).click();
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Download original" }).click()]);
      expect(dl.suggestedFilename()).toBe(name);
      const got = readFileSync((await dl.path())!);
      expect(got.equals(buf)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog")).toHaveCount(0);
    }

    // survives a reload
    await page.reload(); // stays unlocked: the tab keeps the key across a reload (web/src/keep.ts)
    await expect(page.locator(".tile")).toHaveCount(4, { timeout: 30_000 });

    // the thumbnails and previews the browser keeps in Cache Storage are the server's ciphertext: no JPEG, no marker
    const kept = await page.evaluate(async (markers) => {
      const out: { url: string; plain: boolean }[] = [];
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const req of await c.keys()) {
          const b = new Uint8Array(await (await c.match(req))!.arrayBuffer());
          const text = new TextDecoder("latin1").decode(b);
          out.push({ url: new URL(req.url).pathname, plain: (b[0] === 0xff && b[1] === 0xd8) || ["JFIF", "Exif", ...markers].some((m) => text.includes(m)) });
        }
      }
      return out;
    }, [MARKER_NAME, MARKER_EXIF]);
    expect(kept.filter((k) => k.url.startsWith("/ct/preview/")).length).toBeGreaterThanOrEqual(2);
    expect(kept.filter((k) => k.url.startsWith("/ct/thumb/")).length).toBeGreaterThanOrEqual(3);
    expect(kept.filter((k) => k.plain)).toEqual([]);
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/markers.txt", [MARKER_NAME, MARKER_EXIF].join("\n") + "\n");
    await ctx.close();
  });

  test("other users cannot read carol's items through the API", async ({ browser }) => {
    const c = await newPage(browser);
    await signIn(c.page, CAROL, CAROL_PW);
    const id: string = await c.page.evaluate(async () => (await (await fetch("/api/items")).json()).items[0].id);

    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    for (const p of ["thumb", "preview", "segments/0", "upload"]) {
      expect(await a.page.evaluate(async (u) => (await fetch(u)).status, `/api/items/${id}/${p}`)).toBe(404);
    }
    expect(await a.page.evaluate(async () => (await (await fetch("/api/items")).json()).items.length)).toBe(0);
    await c.ctx.close();
    await a.ctx.close();
  });

  test("phone viewport: library has no horizontal scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await signIn(page, CAROL, CAROL_PW);
    await expect(page.locator(".tile")).toHaveCount(4, { timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await page.screenshot({ path: "test-results/phone-library.png" });
    await ctx.close();
  });
});
