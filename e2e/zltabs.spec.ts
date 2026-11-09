import { expect, Page, test } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

// Two tabs of one browser share the session cookie. Signing out in one tab ends the session of the other too: that
// tab lets go of its keys and its decrypted library at once, without a reload or a request of its own.
const LIV = "liv@example.org"; // made by zlive.spec.ts
const LIV_PW = pw("liv");

async function openLibrary(page: Page) {
  await page.goto("/");
  const unlock = page.getByRole("button", { name: "Unlock" });
  const timeline = page.getByRole("button", { name: "Timeline" });
  await expect(unlock.or(timeline).or(page.getByLabel("E-mail"))).toBeVisible({ timeout: 30_000 });
  if (await page.getByLabel("E-mail").isVisible()) {
    await page.getByLabel("E-mail").fill(LIV);
    await page.getByLabel("Password").fill(LIV_PW);
    await page.getByRole("button", { name: "Sign in" }).click();
  } else if (await unlock.isVisible()) {
    await page.getByLabel("Password").fill(LIV_PW);
    await unlock.click();
  }
  await expect(timeline).toBeVisible({ timeout: 30_000 });
}

test("signing out in one tab signs out the other tabs of the browser", async ({ browser }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const one = await ctx.newPage();
  const two = await ctx.newPage();
  await openLibrary(one);
  await openLibrary(two);
  await openMenuItem(one, "Sign out");
  await expect(one.getByLabel("E-mail")).toBeVisible({ timeout: 15_000 });
  // the other tab is on the sign-in screen within moments, its library gone from the page
  await expect(two.getByText("You were signed out in another tab.")).toBeVisible({ timeout: 5_000 });
  await expect(two.getByLabel("E-mail")).toBeVisible();
  await expect(two.getByRole("button", { name: "Timeline" })).toHaveCount(0);
  expect(await two.evaluate(() => document.querySelectorAll("img[src^='blob:']").length)).toBe(0);
  await ctx.close();
});
