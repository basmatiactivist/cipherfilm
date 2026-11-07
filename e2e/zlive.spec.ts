import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Live updates: two signed-in devices (two browser contexts, two sessions) of one account. What one uploads, moves to
// the trash or restores shows on the other within a few seconds, without a reload.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const LIV = "liv@example.org";
const LIV_PW = pw("liv");
const png = readFileSync(join(__dirname, "fixtures/sample.png"));

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
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

/** A change through the API, as another app would make it. */
const post = (page: Page, path: string, body: unknown) => page.evaluate(async ([path, body]) => {
  const { csrf } = await (await fetch("/api/me")).json();
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  return r.status;
}, [path, body] as const);

test("a change on one device shows on the other within seconds, without a reload", async ({ browser }) => {
  const a = await newPage(browser);
  await signIn(a.page, ADMIN, ADMIN_PW);
  await openMenuItem(a.page, "Admin");
  await a.page.getByLabel("Their e-mail").fill(LIV);
  await a.page.getByRole("button", { name: "Create invite link" }).click();
  const link = await a.page.getByLabel("Invite link").inputValue();
  await a.ctx.close();

  // the "phone": joins and stays signed in
  const phone = await newPage(browser);
  await phone.page.goto(link);
  await phone.page.getByLabel("Password", { exact: true }).fill(LIV_PW);
  await phone.page.getByLabel("Repeat password").fill(LIV_PW);
  await phone.page.getByRole("button", { name: "Create account" }).click();
  await phone.page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
  await phone.page.getByRole("button", { name: "Continue" }).click();
  await expect(phone.page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();

  // the "web app" on another computer: its own session, its stream open
  const web = await newPage(browser);
  const opened = web.page.waitForResponse((r) => r.url().endsWith("/api/events") && r.status() === 200);
  await signIn(web.page, LIV, LIV_PW);
  await opened;
  await expect(web.page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
  let navigations = 0;
  web.page.on("framenavigated", (f) => { if (f === web.page.mainFrame()) navigations++; });

  const lines: string[] = [];
  const timed = async (what: string, act: () => Promise<number>, shown: () => Promise<void>) => {
    const t0 = await act();
    await shown();
    const ms = Date.now() - t0;
    lines.push(`${what}: ${ms} ms`);
    console.log(`[live] ${what} shown on the other device after ${ms} ms`);
    expect(ms).toBeLessThan(5000);
  };

  // an upload on the phone: from its finalize to the tile on the web app
  await timed("upload", async () => {
    const done = phone.page.waitForResponse((r) => /\/api\/items\/[0-9a-f]{32}\/finalize$/.test(r.url()) && r.status() === 200, { timeout: 60_000 });
    await phone.page.locator('input[type="file"]').setInputFiles([{ name: "live.png", mimeType: "image/png", buffer: png }]);
    await done;
    return Date.now();
  }, () => expect(web.page.locator(".tile")).toHaveCount(1, { timeout: 5000 }));

  const id: string = await phone.page.evaluate(async () => (await (await fetch("/api/items")).json()).items[0].id);
  await timed("trash", async () => { expect(await post(phone.page, "/api/items/trash", { item_ids: [id] })).toBe(200); return Date.now(); },
    async () => {
      await expect(web.page.locator(".tile")).toHaveCount(0, { timeout: 5000 });
      await expect(web.page.getByRole("button", { name: "Trash (1)" })).toBeVisible({ timeout: 5000 });
    });
  await timed("restore", async () => { expect(await post(phone.page, "/api/items/restore", { item_ids: [id] })).toBe(200); return Date.now(); },
    () => expect(web.page.locator(".tile")).toHaveCount(1, { timeout: 5000 }));
  await timed("favorite", async () => { expect(await post(phone.page, "/api/items/favorite", { item_ids: [id], favorite: true })).toBe(200); return Date.now(); },
    async () => {
      await web.page.getByRole("button", { name: "Favorites" }).click();
      await expect(web.page.locator(".tile")).toHaveCount(1, { timeout: 5000 });
    });

  expect(navigations).toBe(0); // all without a reload
  mkdirSync("test-results", { recursive: true });
  appendFileSync("test-results/live.txt", lines.join("\n") + "\n");
  await phone.ctx.close();
  await web.ctx.close();
});
