import { expect, test, Browser, Page } from "@playwright/test";
import { pw } from "./creds";

const BASE = process.env.BASE_URL ?? "https://cipherfilm.orb.local";
const CAROL = "carol@example.org";
const CAROL_PW = pw("carol");

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  return { ctx, page: await ctx.newPage() };
}
async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(CAROL);
  await page.getByLabel("Password").fill(CAROL_PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
}

test.describe("shortcuts and quick actions", () => {
  test("keyboard: help, select all, delete to trash with undo, go-to keys, search focus", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const before = await page.locator(".tile").count();

    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);

    await page.keyboard.press("/");
    await expect(page.getByLabel("Search your photos")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator("main").click({ position: { x: 5, y: 5 } });

    await page.keyboard.press("s");
    await expect(page.locator(".selbar")).toBeVisible();
    await page.locator(".tile").first().click();
    await expect(page.locator(".selcount")).toHaveText("1 selected");
    await page.keyboard.press("Delete"); // direct, no extra menu
    await expect(page.locator(".tile")).toHaveCount(before - 1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tile")).toHaveCount(before);

    await page.keyboard.press("Control+a");
    await expect(page.locator(".selcount")).toHaveText(`${before} selected`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".selbar")).toHaveCount(0);

    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await expect(page.getByRole("heading", { level: 1, name: "Albums" })).toBeVisible();
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
    await ctx.close();
  });

  test("shift-click selects a range; the selection bar trashes directly", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const before = await page.locator(".tile").count();
    expect(before).toBeGreaterThanOrEqual(3);
    await page.locator(".tile").nth(0).click({ modifiers: ["ControlOrMeta"] });
    await page.locator(".tile").nth(2).click({ modifiers: ["Shift"] });
    await expect(page.locator(".selcount")).toHaveText("3 selected");
    await page.locator(".selbar").getByRole("button", { name: "Move to trash" }).click();
    await expect(page.locator(".tile")).toHaveCount(before - 3);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tile")).toHaveCount(before);
    await ctx.close();
  });

  test("right-click on a photo offers quick actions; Escape closes the menu", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const before = await page.locator(".tile").count();
    await page.locator(".tile").first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Photo actions" });
    await expect(menu).toBeVisible();
    for (const n of ["Open", "Select", "Download original", "Move to trash"]) await expect(menu.getByRole("menuitem", { name: n })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.locator(".tile").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(page.locator(".tile")).toHaveCount(before - 1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tile")).toHaveCount(before);

    await page.locator(".tile").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open" }).click();
    await expect(page.locator("dialog.lightbox")).toBeVisible();
    await page.keyboard.press("i");
    await expect(page.getByRole("complementary", { name: "Details" })).toBeVisible();
    // no index entries from an Android or Mac app: no People section, and the details say how to get one
    await expect(page.getByRole("complementary", { name: "Details" })).toContainText("Turn on search in the Android or Mac app");
    await expect(page.getByRole("button", { name: "People" })).toHaveCount(0);
    await ctx.close();
  });

  test("narrowing the search drops hidden photos from the selection, so Delete only touches what you see", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const before = await page.locator(".tile").count();
    expect(before).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Control+a");
    await expect(page.locator(".selcount")).toHaveText(`${before} selected`);
    const first = (await page.locator(".tile").first().getAttribute("aria-label"))!.replace(/^Open /, "").replace(/(, video|, no preview|: couldn't be verified)$/, "");
    await page.getByLabel("Search your photos").fill(first);
    await expect(page.locator(".tile")).toHaveCount(1);
    await expect(page.locator(".selcount")).toHaveText("1 selected");
    await page.locator(".selbar").getByRole("button", { name: "Move to trash" }).click();
    await page.getByLabel("Search your photos").fill("");
    await expect(page.locator(".tile")).toHaveCount(before - 1); // the others were never touched
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tile")).toHaveCount(before);
    await ctx.close();
  });
  test("search finds photos by date and type, not only by name", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const all = await page.locator(".tile").count();
    const search = page.getByLabel("Search your photos");
    await search.fill(String(new Date().getFullYear())); // the test files carry today's file date
    await expect(page.locator(".tile")).toHaveCount(all);
    await search.fill("1999");
    await expect(page.locator(".tile")).toHaveCount(0);
    await expect(page.getByText("Nothing matches “1999”")).toBeVisible();
    await search.fill("video"); // the library is filtered 150 ms after typing stops
    await expect.poll(() => page.locator(".tile").count()).toBeGreaterThan(0);
    const videos = await page.locator(".tile").count();
    expect(videos).toBeLessThan(all);
    await ctx.close();
  });

  test("favorites: F in the viewer, the Favorites page, the note seen while scrolled, focus back on the photo", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page);
    const first = page.locator(".tile").first();
    const name = (await first.getAttribute("aria-label"))!;
    await first.click();
    await expect(page.locator("dialog.lightbox")).toBeVisible();
    await page.keyboard.press("f");
    await expect(page.locator("dialog.lightbox").getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.lightbox")).toHaveCount(0);
    await expect(page.locator(".tile").first()).toBeFocused(); // not lost on the page body
    await expect(page.locator(".tile").first()).toHaveAttribute("aria-label", `${name}, favorite`);
    await page.keyboard.press("g");
    await page.keyboard.press("f");
    await expect(page.getByRole("heading", { level: 1, name: "Favorites" })).toBeVisible();
    await expect(page.locator(".tile")).toHaveCount(1);
    // unmark from the selection bar while scrolled down: the note is on screen, not at the top of the page
    await page.keyboard.press("s");
    await page.locator(".tile").first().click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator(".selbar").getByRole("button", { name: "Favorite" }).click();
    await expect(page.getByRole("heading", { name: "No favorites yet" })).toBeVisible();
    await expect(page.locator(".selbar")).toHaveCount(0);
    const note = page.locator(".toasts .note");
    await expect(note).toContainText("Removed from favorites");
    await expect(note).toBeInViewport();
    await ctx.close();
  });
});
