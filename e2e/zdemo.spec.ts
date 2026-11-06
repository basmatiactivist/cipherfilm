import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The public demo login (DEMO_ACCOUNTS in compose.e2e.yaml): it can sign in and look, every change is refused.
const ADMIN = "admin@example.org";
const GRACE = "grace@example.org";
const REFUSED = "This is the public demo: changes are turned off.";

const png = readFileSync(join(__dirname, "fixtures/sample.png"));

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  return { ctx, page };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}

test.describe.serial("public demo", () => {
  test("grace joins; the demo notice shows and uploads are refused", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, pw("admin"));
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(GRACE);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(pw("grace"));
    await page.getByLabel("Repeat password").fill(pw("grace"));
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("note")).toHaveText("Public demo · read-only · resets every hour");
    await expect(page.getByRole("button", { name: "Upload photos and videos" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add photos and videos" })).toHaveCount(0);
    // a dropped file (here: the file input) gets the server's own words
    await page.locator('input[type="file"]').setInputFiles([{ name: "one.png", mimeType: "image/png", buffer: png }]);
    await expect(page.getByRole("alert")).toContainText(REFUSED);
    // and the server refuses it however it is asked
    const r = await page.evaluate(async () => {
      const me = await (await fetch("/api/me")).json();
      const res = await fetch("/api/albums", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf }, body: JSON.stringify({ id: "0".repeat(32), name_enc: "AAAA" }) });
      return { demo: me.demo, status: res.status, error: (await res.json()).error };
    });
    expect(r).toEqual({ demo: true, status: 403, error: REFUSED });
    await ctx.close();
  });

  test("the account page has no password, recovery, devices or delete", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, GRACE, pw("grace"));
    await openMenuItem(page, "Account");
    await expect(page.getByText("Storage", { exact: true })).toBeVisible();
    for (const title of ["Change password", "Recovery key", "Devices", "Delete account"]) {
      await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    }
    await openMenuItem(page, "Sign out");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await ctx.close();
  });
});
