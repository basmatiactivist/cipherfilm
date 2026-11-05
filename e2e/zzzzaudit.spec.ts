import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import AxeBuilder from "@axe-core/playwright";

// Automated accessibility audit (axe-core, WCAG 2.2 A/AA) of every main screen at phone, tablet and desktop widths.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const ERIN = "erin@example.org";
const ERIN_PW = pw("erin");
const SIZES = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

async function newPage(browser: Browser, size: { width: number; height: number }) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: size, isMobile: size.width < 600, hasTouch: size.width < 800 });
  return { ctx, page: await ctx.newPage() };
}
async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
}
async function scan(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = r.violations.map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect(bad, bad.join("\n")).toEqual([]);
}
async function noHorizontalScroll(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${where}: horizontal scroll`).toBe(true);
}

for (const size of SIZES) {
  test.describe(`a11y at ${size.name} (${size.width}px)`, () => {
    test("signed-out screens", async ({ browser }) => {
      const { ctx, page } = await newPage(browser, size);
      for (const [path, heading] of [["/", "Sign in"], ["/recover", "Reset your password"], ["/invite/0000", "Invite not valid"]] as const) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        await scan(page, `${size.name} ${path}`);
        await noHorizontalScroll(page, `${size.name} ${path}`);
      }
      await ctx.close();
    });

    test("library, select mode, lightbox, albums, trash, account", async ({ browser }) => {
      const { ctx, page } = await newPage(browser, size);
      await signIn(page, ERIN, ERIN_PW);
      await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
      await scan(page, `${size.name} timeline`);
      await noHorizontalScroll(page, `${size.name} timeline`);

      await page.getByRole("button", { name: "Select" }).click();
      await page.locator(".tile").first().click();
      await expect(page.locator(".selbar").getByRole("button", { name: "Add to album" })).toBeEnabled();
      await page.waitForTimeout(500); // let the 0.15s colour transition finish so axe doesn't measure a half-faded button
      await scan(page, `${size.name} select mode`);
      await page.locator(".selbar").getByRole("button", { name: "Done" }).click();

      await page.locator(".tile").first().click();
      await expect(page.locator("dialog.lightbox")).toBeVisible();
      await scan(page, `${size.name} lightbox`);
      await page.keyboard.press("Escape");

      for (const tab of ["Albums", "Trash"]) {
        await page.getByRole("button", { name: new RegExp("^" + tab) }).click();
        await expect(page.locator(".content")).toBeVisible();
        await scan(page, `${size.name} ${tab}`);
        await noHorizontalScroll(page, `${size.name} ${tab}`);
      }
      await openMenuItem(page, "Account");
      await expect(page.locator("summary", { hasText: "Recovery key" })).toBeVisible();
      for (const sm of await page.locator("summary").all()) await sm.click(); // scan the cards open, too
      // from the top: a button scrolled under the sticky header counts as too small a target for axe
      await page.evaluate(() => window.scrollTo(0, 0));
      await scan(page, `${size.name} account`);
      await noHorizontalScroll(page, `${size.name} account`);
      await ctx.close();
    });

    test("admin people screen", async ({ browser }) => {
      const { ctx, page } = await newPage(browser, size);
      await signIn(page, ADMIN, ADMIN_PW);
      await openMenuItem(page, "Admin");
      await expect(page.getByRole("heading", { name: "Invite someone" })).toBeVisible();
      await scan(page, `${size.name} people`);
      await noHorizontalScroll(page, `${size.name} people`);
      await ctx.close();
    });
  });
}
