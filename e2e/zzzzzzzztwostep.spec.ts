import { createHmac } from "node:crypto";
import { Browser, expect, Page, test } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

// Two-step sign-in on the web: turn it on (QR and key), sign in with a code from the "app" (a TOTP made here), with a
// recovery code, the new-sign-in notice on the other browser, and an admin turning it off for someone who lost their
// phone. Its own account, so the other specs' sign-ins are not affected.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const GRACE = "grace@example.org";
const GRACE_PW = pw("grace");

/** RFC 6238 with SHA-1, 6 digits, 30 seconds: what an authenticator app shows for this key at this time. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/[\s=]/g, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A code the server hasn't seen yet: it accepts each time step once, so wait for the next one after the last used. */
let lastStep = 0;
async function freshCode(secret: string): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 500));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp(secret);
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  return { ctx, page };
}

async function passwordStep(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const library = (page: Page) => expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });

let secret = "";
let codes: string[] = [];

test.describe.serial("two-step sign-in", () => {
  test.setTimeout(180_000);

  test("grace joins and turns on two-step sign-in", async ({ browser }) => {
    const a = await newPage(browser);
    await passwordStep(a.page, ADMIN, ADMIN_PW);
    await library(a.page);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(GRACE);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(GRACE_PW);
    await page.getByLabel("Repeat password").fill(GRACE_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await library(page);

    await openMenuItem(page, "Account");
    await page.getByText("Two-step sign-in", { exact: true }).click();
    await page.getByRole("button", { name: "Turn on…" }).click();
    await page.getByLabel("Your password").fill(GRACE_PW);
    await page.getByRole("button", { name: "Continue" }).click();
    // the QR code is drawn in the page; the key is shown as text too
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible({ timeout: 30_000 });
    secret = (await page.locator(".secret code").innerText()).replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel("Code from the app").fill("000000");
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("alert")).toContainText("code isn't right");
    await page.getByLabel("Code from the app").fill(await freshCode(secret));
    await page.getByRole("button", { name: "Turn on" }).click();
    const list = page.getByRole("list", { name: "Recovery codes" });
    await expect(list.locator("li")).toHaveCount(10);
    codes = (await list.locator("li").allInnerTexts()).map((s) => s.trim());
    expect(codes[0]).toMatch(/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
    await page.getByLabel(/I've saved these codes/).check();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("10 of 10 recovery codes left")).toBeVisible();
    await ctx.close();
  });

  test("a new sign-in needs the code; the browser already signed in is told", async ({ browser }) => {
    // the first browser: signed in with a code, then watching for the next sign-in
    const first = await newPage(browser);
    await passwordStep(first.page, GRACE, GRACE_PW);
    const code = first.page.getByLabel("Code", { exact: true });
    await expect(code).toBeVisible({ timeout: 30_000 });
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    // nothing of the library before the code
    await expect(first.page.getByRole("button", { name: "Timeline" })).toHaveCount(0);
    await code.fill("000000");
    await first.page.getByRole("button", { name: "Sign in" }).click();
    await expect(first.page.getByRole("alert")).toContainText("code isn't right");
    await code.fill(await freshCode(secret));
    await first.page.getByRole("button", { name: "Sign in" }).click();
    await library(first.page);

    // a second browser signs in with a recovery code
    const second = await newPage(browser);
    await passwordStep(second.page, GRACE, GRACE_PW);
    await second.page.getByRole("button", { name: "Use a recovery code" }).click();
    await second.page.getByLabel("Recovery code").fill(codes[0].toUpperCase());
    await second.page.getByRole("button", { name: "Sign in" }).click();
    await library(second.page);

    // the first browser shows the new sign-in, and leads to the device list
    const notice = first.page.locator(".noticebar");
    await expect(notice).toContainText("New sign-in", { timeout: 15_000 });
    await notice.getByRole("button", { name: "Review devices" }).click();
    await expect(first.page.locator(".devices li")).toHaveCount(2);
    await first.page.locator(".noticebar").getByRole("button", { name: "Dismiss" }).click();
    await expect(first.page.locator(".noticebar")).toHaveCount(0);
    // dismissed for good: the server no longer lists it for this browser
    await expect.poll(async () => (await (await first.page.request.get("/api/me/notices")).json()).notices.length).toBe(0);
    await first.ctx.close();
    await second.ctx.close();

    // a used recovery code doesn't work twice
    const third = await newPage(browser);
    await passwordStep(third.page, GRACE, GRACE_PW);
    await third.page.getByRole("button", { name: "Use a recovery code" }).click();
    await third.page.getByLabel("Recovery code").fill(codes[0]);
    await third.page.getByRole("button", { name: "Sign in" }).click();
    await expect(third.page.getByRole("alert")).toContainText("code isn't right");
    await third.page.getByRole("button", { name: "Start over" }).click();
    await expect(third.page.getByLabel("E-mail")).toBeVisible();
    await third.ctx.close();
  });

  test("an admin turns it off for someone who lost their phone; they are told", async ({ browser }) => {
    const a = await newPage(browser);
    await passwordStep(a.page, ADMIN, ADMIN_PW);
    await library(a.page);
    await openMenuItem(a.page, "Admin");
    const row = a.page.getByRole("listitem", { name: GRACE });
    const pill = row.locator(".pill", { hasText: "two-step sign-in" });
    await expect(pill).toBeVisible();
    await row.getByRole("button", { name: /Turn off two-step sign-in/ }).click();
    await row.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(pill).toHaveCount(0);
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await passwordStep(page, GRACE, GRACE_PW);
    await library(page); // the password alone again
    await expect(page.locator(".noticebar")).toContainText("An administrator turned off two-step sign-in");
    await ctx.close();
  });
});
