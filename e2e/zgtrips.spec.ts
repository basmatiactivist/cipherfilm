import { expect, Page, test, Browser } from "@playwright/test";
import { pw } from "./creds";
import { openMenuItem } from "./nav";

// Trips and the year recap (web/src/memories): ivy uploads photos with dates and places in their EXIF, six days at
// home in Zürich and three days in Rome; the browser finds the trip, saves it as an album, and shows 2024 in review.
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const IVY = "ivy@example.org";
const IVY_PW = pw("ivy");

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

/** An EXIF block (APP1) with the capture time and GPS position, as a camera writes it. */
function exif(when: string, lat: number, lon: number): Buffer {
  const t = Buffer.alloc(178);
  t.write("II", 0, "latin1"); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => { t.writeUInt16LE(tag, at); t.writeUInt16LE(type, at + 2); t.writeUInt32LE(count, at + 4); t.writeUInt32LE(value, at + 8); };
  // IFD0: pointers to the Exif and GPS directories
  t.writeUInt16LE(2, 8); entry(10, 0x8769, 4, 1, 38); entry(22, 0x8825, 4, 1, 76); t.writeUInt32LE(0, 34);
  // Exif: DateTimeOriginal
  t.writeUInt16LE(1, 38); entry(40, 0x9003, 2, 20, 56); t.writeUInt32LE(0, 52); t.write(when + "\0", 56, "latin1");
  // GPS: N/E and degrees, minutes, seconds as rationals
  t.writeUInt16LE(4, 76);
  entry(78, 1, 2, 2, 0); t.write(lat >= 0 ? "N" : "S", 86, "latin1");
  entry(90, 2, 5, 3, 130);
  entry(102, 3, 2, 2, 0); t.write(lon >= 0 ? "E" : "W", 110, "latin1");
  entry(114, 4, 5, 3, 154);
  t.writeUInt32LE(0, 126);
  const dms = (v: number, at: number) => {
    const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 1000);
    [[d, 1], [m, 1], [s, 1000]].forEach(([n, q], i) => { t.writeUInt32LE(n, at + i * 8); t.writeUInt32LE(q, at + i * 8 + 4); });
  };
  dms(lat, 130); dms(lon, 154);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  return Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
}

async function jpegs(page: Page, n: number): Promise<Buffer[]> {
  const list: number[][] = await page.evaluate(async (n) => {
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("canvas");
      c.width = 160; c.height = 120;
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${(i * 37) % 360} 60% 50%)`; g.fillRect(0, 0, 160, 120);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
      out.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
    }
    return out;
  }, n);
  return list.map((b) => Buffer.from(b));
}

test.describe.serial("trips and recaps", () => {
  test("ivy joins and uploads photos from home and from Rome", async ({ browser }) => {
    const a = await newPage(browser);
    await signIn(a.page, ADMIN, ADMIN_PW);
    await openMenuItem(a.page, "Admin");
    await a.page.getByLabel("Their e-mail").fill(IVY);
    await a.page.getByRole("button", { name: "Create invite link" }).click();
    const link = await a.page.getByLabel("Invite link").inputValue();
    await a.ctx.close();

    const { ctx, page } = await newPage(browser);
    await page.goto(link);
    await page.getByLabel("Password", { exact: true }).fill(IVY_PW);
    await page.getByLabel("Repeat password").fill(IVY_PW);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 30_000 });
    await page.getByRole("button", { name: "Continue" }).click();

    const shots: [string, number, number][] = [
      ...[3, 7, 11, 15, 19, 23].map((d): [string, number, number] => [`2024:03:${String(d).padStart(2, "0")} 12:00:00`, 47.3769, 8.5417]),
      ...[10, 11, 12].flatMap((d) => [9, 15].map((h): [string, number, number] => [`2024:05:${d} ${h}:00:00`, 41.9028, 12.4964])),
    ];
    const base = await jpegs(page, shots.length);
    const files = shots.map(([when, lat, lon], i) => {
      const j = base[i];
      return { name: `trip-${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([j.subarray(0, 2), exif(when, lat, lon), j.subarray(2)]) };
    });
    await page.locator('input[type="file"]').setInputFiles(files);
    // the timeline draws only the rows on screen: the upload panel says when all are in
    await expect(page.getByText(`${shots.length} files uploaded`)).toBeVisible({ timeout: 60_000 });
    await ctx.close();
  });

  test("the trip is suggested in Albums and saved as an album", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, IVY, IVY_PW);
    await page.getByRole("button", { name: "Albums" }).click();
    const trips = page.getByRole("list", { name: "Trips" });
    const card = trips.getByRole("button", { name: /Rome, May 2024/ });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(trips.getByRole("button")).toHaveCount(1); // home isn't a trip
    await card.click();
    await expect(page.locator("h1.pagetitle")).toHaveText("Rome, May 2024");
    await expect(page.locator(".triphead")).toContainText("6 items");
    await page.getByRole("button", { name: "Save as album" }).click();
    await expect(page.getByText("Saved as the album “Rome, May 2024”.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Open the album" })).toBeVisible();
    await page.getByRole("button", { name: "Open the album" }).click();
    await expect(page.locator("h1.pagetitle")).toHaveText("Rome, May 2024");
    await expect(page.locator(".timeline .tile").first()).toBeVisible();
    await page.getByRole("button", { name: "All albums" }).click();
    await expect(page.getByRole("list", { name: "Albums" }).getByRole("button", { name: /Rome, May 2024/ })).toContainText("6 items");
    await expect(trips.getByRole("button", { name: /Saved/ })).toBeVisible();
    await ctx.close();
  });

  test("2024 in review", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await signIn(page, IVY, IVY_PW);
    const year = page.getByRole("button", { name: /^2024 in review/ });
    await expect(year).toBeVisible({ timeout: 30_000 });
    await year.click();
    await expect(page.locator("h1.pagetitle")).toHaveText("2024 in review");
    await expect(page.locator(".recapfacts")).toHaveText("12 photos · 9 days · 2 countries");
    await expect(page.getByRole("heading", { name: "Places" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".recap .memago").first()).toHaveText(/Rome|Zürich/);
    await expect(page.getByRole("heading", { name: /^March/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^May/ })).toBeVisible();
    await page.getByRole("button", { name: "Rome, May 2024" }).click();
    await expect(page.locator("h1.pagetitle")).toHaveText("Rome, May 2024");
    await ctx.close();
  });
});
