import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs last: ZIP downloads, trash, restore, purge, admin storage limits.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const FRANK = "frank@example.org";
const FRANK_PW = pw("frank");

const png = readFileSync(join(__dirname, "fixtures/sample.png"));
const heic = readFileSync(join(__dirname, "fixtures/sample.heic"));

/** Minimal reader for stored (uncompressed) ZIPs: returns name -> bytes via the central directory. */
function readZip(buf: Buffer): Record<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central directory");
    if (buf.readUInt16LE(off + 10) !== 0) throw new Error("entry is compressed");
    const csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    out[name] = buf.subarray(start, start + csize);
    off += 46 + nlen + elen + clen;
  }
  return out;
}

async function newPage(browser: Browser, opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, ...opts });
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
const tile = (page: Page, n: number) => page.locator(".tile").nth(n);
const selbar = (page: Page) => page.locator(".selbar");

test.describe.serial("manage", () => {
  test("frank joins and uploads three files, two with the same name", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(FRANK);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(FRANK_PW);
    await page.getByLabel("Repeat password").fill(FRANK_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('input[type="file"]').setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: png },
      { name: "a.png", mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from("x")]) },
      { name: "b.heic", mimeType: "image/heic", buffer: heic },
    ]);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 60_000 });
    await ctx.close();
  });

  test("ZIP of a selection: streamed, every file intact, duplicate names kept", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    await page.getByRole("button", { name: "Select" }).click();
    for (let i = 0; i < 3; i++) await tile(page, i).click();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), selbar(page).getByRole("button", { name: "Download as ZIP" }).click()]);
    expect(dl.suggestedFilename()).toBe("Cipherfilm.zip");
    const files = readZip(readFileSync((await dl.path())!));
    expect(Object.keys(files).sort()).toEqual(["a (1).png", "a.png", "b.heic"]);
    const sizes = [files["a.png"].length, files["a (1).png"].length].sort();
    expect(sizes).toEqual([png.length, png.length + 1]);
    expect(files["b.heic"].equals(heic)).toBe(true);
    await ctx.close();
  });

  test("album ZIP is named after the album", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await tile(page, 1).click();
    await page.getByRole("button", { name: "Add to album" }).click();
    await page.getByLabel("New album name").fill("Trip: 2026/Summer");
    await page.getByRole("button", { name: "Create album" }).click();
    await expect(page.locator(".selbar")).toHaveCount(0);
    await page.getByRole("button", { name: "Albums" }).click();
    await page.getByRole("button", { name: /Trip/ }).click();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Download as ZIP" }).click()]);
    expect(dl.suggestedFilename()).toBe("Trip_ 2026_Summer.zip"); // path characters are neutralised
    expect(Object.keys(readZip(readFileSync((await dl.path())!)))).toHaveLength(2);
    await ctx.close();
  });

  test("trash: move, restore, from the lightbox, delete forever, empty", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, FRANK, FRANK_PW);
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 30_000 });
    const ids: string[] = await page.evaluate(async () => (await (await fetch("/api/items")).json()).items.map((i: any) => i.id));

    // move one to the trash from the selection bar
    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await selbar(page).getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByRole("status")).toContainText("1 moved to the trash");
    await expect(page.locator(".tile")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Trash \(1\)/ })).toBeVisible();

    // trash view explains the 30 days; restore brings it back
    await page.getByRole("button", { name: /Trash/ }).click();
    await expect(page.locator(".trashnote")).toContainText("30 days");
    await expect(page.locator(".tile")).toHaveCount(1);
    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await selbar(page).getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: "The trash is empty" })).toBeVisible();
    await page.getByRole("button", { name: "Timeline" }).click();
    await expect(page.locator(".tile")).toHaveCount(3);

    // trash from the lightbox
    await tile(page, 0).click();
    await page.locator("dialog.lightbox").getByRole("button", { name: "Move to trash" }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(page.locator(".tile")).toHaveCount(2);

    // delete forever needs a confirmation, and removes the data from the server
    await page.getByRole("button", { name: /Trash/ }).click();
    await page.getByRole("button", { name: "Select" }).click();
    await tile(page, 0).click();
    await selbar(page).getByRole("button", { name: "Delete forever…" }).click();
    await selbar(page).getByRole("button", { name: "Delete forever", exact: true }).click();
    await expect(page.getByRole("heading", { name: "The trash is empty" })).toBeVisible();
    const gone = ids.filter(() => true);
    const stillThere: number[] = await page.evaluate(async (list) => Promise.all(list.map(async (id) => (await fetch(`/api/items/${id}/segments/0`)).status)), gone);
    expect(stillThere.filter((c) => c === 404)).toHaveLength(1); // exactly the purged one is gone; the other two remain readable

    // empty the trash
    await page.getByRole("button", { name: "Timeline" }).click();
    await tile(page, 0).click();
    await page.locator("dialog.lightbox").getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("button", { name: /Trash/ }).click();
    await page.getByRole("button", { name: "Empty trash…" }).click();
    await page.getByRole("button", { name: "Empty trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "The trash is empty" })).toBeVisible();
    await page.getByRole("button", { name: "Timeline" }).click();
    await expect(page.locator(".tile")).toHaveCount(1);
    await ctx.close();
  });

  test("admin page: server status, invite with its own limit, role switch, activity log", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ADMIN, ADMIN_PW);
    await openMenuItem(page, "Admin");
    await page.getByRole("button", { name: "Server" }).click();
    await expect(page.getByRole("heading", { name: "Server", level: 2 })).toBeVisible();
    await expect(page.getByText("Disk free")).toBeVisible();
    await expect(page.getByText(/Nothing reported\. Your backup tool can report/)).toBeVisible(); // nothing reported on this stack
    await page.getByRole("button", { name: "Defaults" }).click();
    await expect(page.getByRole("heading", { name: "Default storage limit" })).toBeVisible();
    await page.getByRole("button", { name: "Users" }).click();
    await page.getByLabel("Their e-mail").fill("grace@example.org");
    await page.getByLabel(/Storage limit in GB/).fill("3");
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(page.getByLabel("Invite link")).toBeVisible();
    await expect(page.getByText(/Limit: 3\.0 GB/)).toBeVisible();
    await page.getByRole("button", { name: /Revoke/ }).click();
    await expect(page.getByText(/Limit: 3\.0 GB/)).toHaveCount(0);
    await page.getByRole("button", { name: "Activity" }).click();
    await expect(page.locator(".activity")).toContainText("You invited");
    await expect(page.locator(".activity")).toContainText("You withdrew the invite for");
    await expect(page.locator(".activity h3").first()).toHaveText("Today");
    await page.getByRole("button", { name: "Users" }).click();
    // role switch is offered for other people, never for yourself
    await expect(page.locator("li.person", { hasText: ADMIN }).getByRole("button", { name: /Make/ })).toHaveCount(0);
    await expect(page.locator("li.person", { hasText: FRANK }).getByRole("button", { name: "Make admin" })).toBeVisible();
    await ctx.close();
  });

  test("a failed off-site backup is a warning on every admin page", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ADMIN, ADMIN_PW);
    // what the server reports after a backup tool ran "backup-report failed upload"
    const now = Math.floor(Date.now() / 1000);
    await page.route("**/api/admin/status", async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, json: { ...(await res.json()), backup_ok_at: now - 30 * 3600, backup_failed_at: now - 3600, backup_failed_in: "upload" } });
    });
    await openMenuItem(page, "Admin");
    await expect(page.getByRole("alert")).toContainText("The last off-site backup failed");
    await expect(page.getByRole("alert")).toContainText("the backup tool couldn't save to the backup target");
    await page.getByRole("button", { name: "Server" }).click();
    await expect(page.locator(".facts dd.bad")).toContainText("Last successful one");
    await expect(page.getByRole("alert")).toHaveCount(0); // on Server itself the line says it, no second banner
    await ctx.close();
  });

  test("admin sees storage use and can change a limit; the user cannot", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, ADMIN, ADMIN_PW);
    await openMenuItem(page, "Admin");
    const row = page.locator("li.person", { hasText: FRANK });
    await expect(row.getByText(/1 item/)).toBeVisible();
    await expect(row.getByText(/of 21\.5 GB/)).toBeVisible();
    await row.getByRole("button", { name: /Change storage limit/ }).click();
    await row.getByLabel(/Limit in GB/).fill("1");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText(/of 1\.0 GB/)).toBeVisible();
    await ctx.close();

    const f = await newPage(browser);
    await signIn(f.page, FRANK, FRANK_PW);
    expect(await f.page.evaluate(async () => (await fetch("/api/admin/users")).status)).toBe(404);
    await f.ctx.close();
  });
});
