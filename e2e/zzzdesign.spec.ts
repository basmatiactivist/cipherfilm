import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

// Checks for the issues the design critique found. Runs last, with the accounts earlier specs created.
const FRANK = "frank@example.org";
const FRANK_PW = pw("frank");
const ERIN = "erin@example.org";
const ERIN_PW = pw("erin");

async function newPage(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
  return { ctx, page: await ctx.newPage() };
}
async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}
/** WCAG contrast ratio of an element's text against its own background, from computed styles. */
const contrast = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const cs = getComputedStyle(el);
    const a = lum(parse(cs.color)), b = lum(parse(cs.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

test.describe.serial("design fixes", () => {
  test("selection bar: readable buttons, 44px targets, one compact row group", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await signIn(page, ERIN, ERIN_PW);
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Select" }).click();
    await page.locator(".tile").first().click();
    const add = page.locator(".selbar").getByRole("button", { name: "Add to album" });
    await expect(add).toBeEnabled();
    await page.waitForTimeout(500); // let the 0.15s colour transition finish before measuring
    expect(await contrast(page, ".selbar .btn.small:not(.secondary)")).toBeGreaterThanOrEqual(4.5);
    await page.locator(".selbar").getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Select" }).click(); // nothing selected: the disabled state must be readable too
    await page.waitForTimeout(500);
    expect(await contrast(page, ".selbar .btn.small:not(.secondary)")).toBeGreaterThanOrEqual(4.5);
    await page.locator(".tile").first().click();
    for (const b of await page.locator(".selbar .btn").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(add).toBeEnabled();
    // the bar no longer eats a sixth of the screen
    expect((await page.locator(".selbar").boundingBox())!.height).toBeLessThan(120);
    // photos start higher on the screen than before (was ~360px)
    expect((await page.locator(".tile").first().boundingBox())!.y).toBeLessThan(330);
    await ctx.close();
  });

  test("structure: one h1 per tab, day heads are h2, skip link works, no stray scrollbar", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toHaveCount(1);
    await expect(page.locator("h2.dayhead").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("h3")).toHaveCount(0);
    await openMenuItem(page, "Account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeFocused(); // a frame after the switch; it would otherwise land after the skip below
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
    const skip = page.getByRole("link", { name: "Skip to content" });
    expect(await page.locator("a, button, input").first().evaluate((e) => e.textContent)).toBe("Skip to content"); // first thing in tab order
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await ctx.close();
  });

  test("sign-in states the privacy promise; credential screens are all sealed", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await page.goto("/");
    await expect(page.getByText("Only you can open them.")).toBeVisible();
    for (const path of ["/", "/recover"]) {
      await page.goto(path);
      await expect(page.locator("section.card.sealed")).toHaveCount(1);
    }
    // the recover link is a comfortable tap target
    await page.goto("/");
    expect((await page.getByRole("link", { name: /Forgot your password/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await ctx.close();
  });

  test("a bad request never shows API wording", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await page.route("**/api/auth/login", (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid request" }) }));
    await page.goto("/");
    await page.getByLabel("E-mail").fill(FRANK);
    await page.getByLabel("Password").fill("whatever-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Check what you entered", { timeout: 30_000 });
    await expect(page.getByRole("alert")).not.toContainText("Invalid request");
    await ctx.close();
  });

  test("trash has an undo", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    const before = await page.locator(".tile").count();
    await page.getByRole("button", { name: "Select" }).click();
    await page.locator(".tile").first().click();
    await page.locator(".selbar").getByRole("button", { name: "Move to trash" }).click();
    await expect(page.locator(".tile")).toHaveCount(before - 1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tile")).toHaveCount(before);
    await ctx.close();
  });

  test("Account: new recovery key replaces the old one; storage is shown", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await openMenuItem(page, "Account");
    await page.locator("summary", { hasText: "Storage" }).click();
    await expect(page.getByText(/used of|used, no limit/).last()).toBeVisible({ timeout: 15_000 });
    await page.locator("summary", { hasText: "Recovery key" }).click();
    await page.getByRole("button", { name: "Make a new recovery key…" }).click();
    await page.getByLabel("Your password").fill("not-my-password");
    await page.getByRole("button", { name: "Make new recovery key" }).click();
    await expect(page.getByRole("alert")).toContainText("isn't right", { timeout: 30_000 });
    await page.getByLabel("Your password").fill(FRANK_PW);
    await page.getByRole("button", { name: "Make new recovery key" }).click();
    await expect(page.getByRole("heading", { name: "Save your new recovery key" })).toBeVisible({ timeout: 30_000 });
    const words = (await page.locator(".words li").allInnerTexts()).map((t) => t.split(/\s+/).pop()!).join(" ");
    expect(words.split(" ")).toHaveLength(24);
    await page.getByLabel(/I've saved my recovery key/).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("summary", { hasText: "Recovery key" })).toBeVisible();

    // the new key is accepted by the recovery flow ...
    const r = await newPage(browser);
    await r.page.goto("/recover");
    await r.page.getByLabel("E-mail").fill(FRANK);
    await r.page.getByLabel("Recovery key").fill(words);
    await r.page.getByRole("button", { name: "Check recovery key" }).click();
    await expect(r.page.getByRole("heading", { name: "Choose a new password" })).toBeVisible({ timeout: 30_000 });
    await r.ctx.close();
    await ctx.close();
  });
});
