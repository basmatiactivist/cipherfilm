import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Archive and locked folder (docs/EDITING.md): an archived photo leaves the timeline but stays in search and albums;
// a locked one shows only in the locked folder, behind the password every time, and leaves nothing in the browser's
// picture cache.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const FERN = "fern@example.org";
const FERN_PW = pw("fern");
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
const nav = (page: Page, name: string) => page.locator("nav.side").getByRole("button", { name, exact: true }).click();
const selbar = (page: Page) => page.locator(".selbar");
/** Archive, Unarchive and Move to locked folder are under More in the selection bar. */
async function more(page: Page, action: string) {
  await selbar(page).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: action, exact: true }).click();
}
const tileOf = (page: Page, name: string) => page.locator(`.tile[aria-label*="${name}"]`);
async function selectOnly(page: Page, name: string) {
  await page.locator(".pagehead").getByRole("button", { name: "Select", exact: true }).click();
  await tileOf(page, name).click();
  await expect(page.locator(".selcount")).toHaveText("1 selected");
}
/** What the browser keeps in Cache Storage for the pictures: the stored ids, thumbnails and previews. */
const storedPictures = (page: Page) => page.evaluate(async () => {
  const out: string[] = [];
  for (const name of ["cf-thumbs-v1", "cf-previews-v1"]) {
    const c = await caches.open(name);
    for (const r of await c.keys()) { const p = new URL(r.url).pathname; if (!p.endsWith("preview-index")) out.push(p); }
  }
  return out;
});
const idOf = (page: Page, name: string) => tileOf(page, name).getAttribute("data-id");

test.describe.serial("archive and locked folder", () => {
  test("fern joins and uploads three photos, one in an album", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(FERN);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(FERN_PW);
    await page.getByLabel("Repeat password").fill(FERN_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "keep.png", mimeType: "image/png", buffer: png },
      { name: "receipt.png", mimeType: "image/png", buffer: png },
      { name: "private.png", mimeType: "image/png", buffer: png },
    ]);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 60_000 });
    await selectOnly(page, "private.png");
    await selbar(page).getByRole("button", { name: "Add to album" }).click();
    await page.getByLabel("New album name").fill("Trip");
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(selbar(page)).toHaveCount(0);
    await ctx.close();
  });

  test("archive: out of the timeline, still in search and the Archive view", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FERN, FERN_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    await selectOnly(page, "receipt.png");
    await more(page, "Archive");
    await expect(page.getByText("Archived.")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".tile")).toHaveCount(2);
    await expect(tileOf(page, "receipt.png")).toHaveCount(0);

    await page.getByLabel("Search your photos").fill("receipt");
    await expect(tileOf(page, "receipt.png")).toHaveCount(1, { timeout: 10_000 });
    await page.getByLabel("Search your photos").fill("");

    await nav(page, "Archive");
    await expect(page.locator(".tile")).toHaveCount(1);
    await expect(tileOf(page, "receipt.png")).toHaveCount(1);

    // another session sees the same: the folder is in the item's (encrypted) metadata, not in this browser
    const other = await newPage(browser);
    await signIn(other.page, FERN, FERN_PW);
    await expect(other.page.locator(".tile")).toHaveCount(2, { timeout: 30_000 });
    await other.ctx.close();

    await selectOnly(page, "receipt.png");
    await more(page, "Unarchive");
    await expect(page.getByText("Back in the timeline.")).toBeVisible({ timeout: 15_000 });
    await nav(page, "Timeline");
    await expect(page.locator(".tile")).toHaveCount(3);
    await ctx.close();
  });

  test("locked folder: nowhere else, password every time, nothing in the picture cache", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FERN, FERN_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    const id = await idOf(page, "private.png");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect.poll(async () => (await storedPictures(page)).some((p) => p.includes(id!)), { timeout: 15_000 }).toBe(true);

    await selectOnly(page, "private.png");
    await more(page, "Move to locked folder");
    await expect(page.getByText("Moved to the locked folder.")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".tile")).toHaveCount(2);
    // its stored pictures went with it
    expect((await storedPictures(page)).filter((p) => p.includes(id!))).toEqual([]);

    // not in search, not in the album (which keeps it: the album shows no item and counts none)
    await page.getByLabel("Search your photos").fill("private");
    await expect(page.getByText(/Nothing matches/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".tile")).toHaveCount(0);
    await page.getByLabel("Search your photos").fill("");
    await nav(page, "Albums");
    await expect(page.getByRole("button", { name: /Trip/ })).toContainText("0 items");
    await page.getByRole("button", { name: /Trip/ }).click();
    await expect(page.getByRole("heading", { name: "This album is empty" })).toBeVisible();

    // the folder asks for the password; a wrong one doesn't open it
    await nav(page, "Locked folder");
    await expect(page.locator(".tile")).toHaveCount(0);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Open locked folder" }).click();
    await expect(page.getByText("That password isn't right.")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Password").fill(FERN_PW);
    await page.getByRole("button", { name: "Open locked folder" }).click();
    await expect(tileOf(page, "private.png")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(".tile")).toHaveCount(1);

    // its picture opens, and is not stored
    await tileOf(page, "private.png").click();
    const dlg = page.locator("dialog.lightbox");
    await expect(dlg.locator(".stage img")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    expect((await storedPictures(page)).filter((p) => p.includes(id!))).toEqual([]);

    // leaving closes it: the password again next time
    await nav(page, "Timeline");
    await nav(page, "Locked folder");
    await expect(page.getByRole("button", { name: "Open locked folder" })).toBeVisible();
    await expect(page.locator(".tile")).toHaveCount(0);
    await page.getByLabel("Password").fill(FERN_PW);
    await page.getByRole("button", { name: "Open locked folder" }).click();
    await expect(tileOf(page, "private.png")).toHaveCount(1, { timeout: 30_000 });

    // moving it out puts it back everywhere, also in its album
    await selectOnly(page, "private.png");
    await selbar(page).getByRole("button", { name: "Move out of locked folder" }).click();
    await expect(page.getByText("Moved out of the locked folder.")).toBeVisible({ timeout: 15_000 });
    await nav(page, "Albums");
    await expect(page.getByRole("button", { name: /Trip/ })).toContainText("1 item");
    await nav(page, "Timeline");
    await expect(page.locator(".tile")).toHaveCount(3);
    await ctx.close();
  });
});
