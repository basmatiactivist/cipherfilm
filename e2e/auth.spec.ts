import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

const TOKEN = process.env.SETUP_TOKEN ?? "";
const ADMIN = "admin@example.org";
const BOB = "bob@example.org";
const ADMIN_PW = pw("admin");
const BOB_PW = pw("bob");
const BOB_PW2 = pw("bob2");

async function readWords(page: Page): Promise<string> {
  const items = await page.locator(".words li").allInnerTexts();
  expect(items).toHaveLength(24);
  // each li is "<n>\n<word>"
  return items.map((t) => t.split(/\s+/).pop()!).join(" ");
}

async function saveKey(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: /recovery key/i })).toBeVisible({ timeout: 30_000 });
  const words = await readWords(page);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel(/I've saved my recovery key/).check();
  await page.getByRole("button", { name: "Continue" }).click();
  return words;
}

async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function newContext(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
  return { ctx, page: await ctx.newPage() };
}

let inviteLink = "";
let bobWords = "";

test.describe.serial("accounts", () => {
  test("first-admin setup, wrong token rejected, recovery key gate", async ({ page }) => {
    test.skip(!TOKEN, "SETUP_TOKEN missing");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Set up Cipherfilm" })).toBeVisible();
    await page.getByLabel("Setup token").fill("not-the-token");
    await page.getByLabel("E-mail").fill(ADMIN);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PW);
    await page.getByLabel("Repeat password").fill(ADMIN_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toContainText(/wrong setup token/i, { timeout: 30_000 });

    await page.getByLabel("Setup token").fill(TOKEN);
    await page.getByRole("button", { name: "Create account" }).click();
    await saveKey(page);
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  });

  test("setup is gone afterwards; admin creates an invite", async ({ browser, page }) => {
    // a fresh visitor now gets the login page, not setup
    const fresh = await newContext(browser);
    await fresh.page.goto("/");
    await expect(fresh.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await fresh.ctx.close();

    await signIn(page, ADMIN, ADMIN_PW);
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });
    await openMenuItem(page, "Admin");
    await page.getByLabel("Their e-mail").fill(BOB);
    await page.getByRole("button", { name: "Create invite link" }).click();
    inviteLink = await page.getByLabel("Invite link").inputValue();
    expect(inviteLink).toMatch(/\/invite\/.+/);
  });

  test("invitee creates an account; link works only once; non-admin has no Admin tab", async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await page.goto(inviteLink);
    await expect(page.getByLabel("E-mail")).toHaveValue(BOB);
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Repeat password").fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toContainText(/at least 10/);
    await page.getByLabel("Password", { exact: true }).fill(BOB_PW);
    await page.getByLabel("Repeat password").fill(BOB_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    bobWords = await saveKey(page);
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Account" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);

    // user A's admin API is invisible to user B
    const status = await page.evaluate(async () => (await fetch("/api/admin/users")).status);
    expect(status).toBe(404);
    await ctx.close();

    const again = await newContext(browser);
    await again.page.goto(inviteLink);
    await expect(again.page.getByRole("heading", { name: "Invite not valid" })).toBeVisible();
    await again.ctx.close();
  });

  test("login errors, a reload stays unlocked, a lock asks for the password, sign out", async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await signIn(page, BOB, "wrong-password-here");
    await expect(page.getByRole("alert")).toContainText(/wrong e-mail or password/i, { timeout: 30_000 });
    await page.getByLabel("Password").fill(BOB_PW);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });

    // a reload keeps the tab unlocked (web/src/keep.ts); a new tab of the same browser asks for the password
    await page.reload();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
    const other = await ctx.newPage();
    await other.goto("/");
    await expect(other.getByRole("heading", { name: "Unlock your library" })).toBeVisible({ timeout: 30_000 });
    await other.close();

    await openMenuItem(page, "Lock");
    await expect(page.getByRole("heading", { name: "Unlock your library" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Unlock your library" })).toBeVisible();
    await page.getByLabel("Password").fill("not-my-password");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("alert")).toContainText(/isn't right/, { timeout: 30_000 });
    await page.getByLabel("Password").fill(BOB_PW);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });

    await openMenuItem(page, "Sign out");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await ctx.close();
  });

  test("password change signs other devices out", async ({ browser }) => {
    const a = await newContext(browser);
    const b = await newContext(browser);
    await signIn(a.page, BOB, BOB_PW);
    await expect(a.page.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });
    await signIn(b.page, BOB, BOB_PW);
    await expect(b.page.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });

    await openMenuItem(b.page, "Account");
    await b.page.locator("summary", { hasText: "Change password" }).click();
    await b.page.getByLabel("Current password").fill(BOB_PW);
    await b.page.getByLabel("New password", { exact: true }).fill(BOB_PW2);
    await b.page.getByLabel("Repeat new password").fill(BOB_PW2);
    await b.page.getByRole("button", { name: "Change password" }).click();
    await expect(b.page.getByText("Password changed.")).toBeVisible({ timeout: 30_000 });

    await a.page.reload();
    await expect(a.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await a.ctx.close();
    await b.ctx.close();
  });

  test("a device is signed out from another one and forgets the library", async ({ browser }) => {
    const a = await newContext(browser);
    const b = await newContext(browser);
    await signIn(a.page, BOB, BOB_PW2);
    await expect(a.page.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });
    await signIn(b.page, BOB, BOB_PW2);
    await expect(b.page.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });

    await openMenuItem(a.page, "Account");
    await a.page.locator("summary", { hasText: /^Devices/ }).click();
    // bob may still be signed in elsewhere from earlier tests: one device is signed out, then all the others
    const list = a.page.locator(".devices li");
    await expect(list.filter({ hasText: "This browser" })).toHaveCount(1, { timeout: 30_000 });
    const n = await list.count();
    expect(n).toBeGreaterThanOrEqual(2);
    if (n > 2) { // the button for all others shows from two others on
      await a.page.getByRole("button", { name: "Sign out all other devices…" }).click();
      await a.page.getByRole("button", { name: `Sign out ${n - 1} devices` }).click();
    } else {
      const other = list.filter({ hasNotText: "This browser" }).first();
      await other.getByRole("button", { name: "Sign out…" }).click();
      await other.getByRole("button", { name: "Sign out", exact: true }).click();
    }
    await expect(list).toHaveCount(1, { timeout: 30_000 });

    // the other browser learns it at its next request, also after a reload, and keeps nothing to unlock
    await b.page.reload();
    await expect(b.page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
    await expect(b.page.getByText(/signed out from another device/)).toBeVisible();
    expect(await b.page.evaluate(() => sessionStorage.getItem("cf.mk"))).toBeNull();
    await a.ctx.close();
    await b.ctx.close();
  });

  test("recovery with the key sets a new password and rotates the key", async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await page.goto("/recover");
    await page.getByLabel("E-mail").fill(BOB);
    await page.getByLabel("Recovery key").fill("abandon ".repeat(24));
    await page.getByRole("button", { name: "Check recovery key" }).click();
    await expect(page.getByRole("alert")).toContainText(/checksum|wrong/i, { timeout: 30_000 });

    await page.getByLabel("Recovery key").fill(bobWords);
    await page.getByRole("button", { name: "Check recovery key" }).click();
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible({ timeout: 30_000 });
    const NEW = pw("bob-recovered");
    await page.getByLabel("Password", { exact: true }).fill(NEW);
    await page.getByLabel("Repeat password").fill(NEW);
    await page.getByRole("button", { name: "Set new password" }).click();
    const newWords = await saveKey(page);
    expect(newWords).not.toEqual(bobWords);

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await signIn(page, BOB, BOB_PW2);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 }); // old password is dead
    await page.getByLabel("Password").fill(NEW);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
    await ctx.close();
  });

  test("phone viewport: no horizontal scroll on sign-in and recovery key", async ({ browser }) => {
    const { ctx, page } = await newContext(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(await overflow()).toBe(false);
    for (const input of await page.locator("input").all()) {
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: "test-results/phone-login.png" });
    await ctx.close();
  });
});
