import { expect, test, Page } from "@playwright/test";
import sodium from "libsodium-wrappers-sumo";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pw } from "./creds";

// Search by what is in a photo: the Android or Mac app stores an image vector per photo in the index, sealed to the
// account's public key. Here two photos get the MobileCLIP text vectors of "dog" and "city at night" from the Python
// reference (onnxruntime 1.31.1) as their image vectors, a third a random one. The browser downloads the real text
// model from the server, turns the typed words into a vector in its worker and must rank the right photo first.
const BASE = process.env.BASE_URL ?? "https://cipherfilm.orb.local";
const CAROL = "carol@example.org";
const CAROL_PW = pw("carol");
const ADMIN = "admin@example.org";
const ADMIN_PW = pw("admin");
const REF: Record<string, number[]> = JSON.parse(readFileSync(join(__dirname, "fixtures", "clip-reference.json"), "utf8"));

function half(f: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, f);
  const x = b.getUint32(0), sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15, m = (x >>> 13) & 0x3ff;
  return e <= 0 ? sign : e >= 31 ? sign | 0x7c00 : sign | (e << 10) | m;
}
const fp16 = (v: number[]) => { const out = new Uint8Array(v.length * 2); v.forEach((f, i) => { const h = half(f); out[2 * i] = h & 255; out[2 * i + 1] = h >> 8; }); return out; };

/** Writes an index entry as the apps do: 0x02 ‖ crypto_box_seal(item id ‖ pad512(JSON)). */
async function putEntry(page: Page, me: { pubkey: string; csrf: string }, item: string, m: string, clip: number[]) {
  await sodium.ready;
  const s = sodium, v = s.base64_variants.URLSAFE_NO_PADDING;
  const json = s.pad(s.from_string(JSON.stringify({ v: 1, m, clip: s.to_base64(fp16(clip), v) })), 512);
  const pt = new Uint8Array(16 + json.length);
  pt.set(s.from_hex(item));
  pt.set(json, 16);
  const sealed = s.crypto_box_seal(pt, s.from_base64(me.pubkey, v));
  const blob = new Uint8Array(1 + sealed.length);
  blob[0] = 2;
  blob.set(sealed, 1);
  // one device indexes (docs/SEARCH.md): this browser takes that over, as "Index here" in an app does
  expect((await page.request.put("/api/me/indexer", { headers: { "X-CSRF-Token": me.csrf } })).ok()).toBeTruthy();
  const r = await page.request.put(`/api/items/${item}/index`, { headers: { "X-CSRF-Token": me.csrf }, data: { data_enc: s.to_base64(blob, v), model: m } }); // the tag in the clear, as the apps send it
  expect(r.ok()).toBeTruthy();
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("E-mail").fill(CAROL);
  await page.getByLabel("Password").fill(CAROL_PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
}

test.describe.serial("search by what is in a photo", () => {
  test("the words become a vector in the browser and rank the photo that shows them first", async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await signIn(page);

    const me = await (await page.request.get("/api/me")).json();
    const items = (await (await page.request.get("/api/items")).json()).items.filter((x: { kind: string }) => x.kind === "image").slice(0, 3);
    expect(items.length).toBe(3);
    const rnd = Array.from({ length: 512 }, () => Math.random() - 0.5);
    for (const [i, v] of [REF["dog"], REF["city at night"], rnd].entries()) await putEntry(page, me, items[i].id, "mcs2/2", v);

    // a fresh sign-in reads the index; the settings say what can be searched
    await page.reload(); // stays unlocked: the tab keeps the key across a reload (web/src/keep.ts)
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    const all = await page.locator(".tile").count();
    const search = page.getByLabel("Search your photos");
    // ranked like Immich: every photo with a vector, best match first, no day headings; photos without one don't show
    await search.fill("dog");
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 120_000 }); // the first search downloads the 64 MB model
    await expect(page.locator(".tile").first()).toHaveAttribute("data-id", items[0].id);
    await expect(page.locator(".dayhead")).toHaveCount(0);
    await search.fill("city at night");
    await expect(page.locator(".tile").first()).toHaveAttribute("data-id", items[1].id, { timeout: 30_000 });
    await expect(page.locator(".tile")).toHaveCount(3);
    await search.fill("");
    await expect(page.locator(".tile")).toHaveCount(all);

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await page.getByText("Search", { exact: true }).click();
    await expect(page.getByText("3 photos can be found by what is in them")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Explicit search" })).toHaveCount(0); // not allowed for carol

    // leave carol's library as it was
    expect((await page.request.delete("/api/index", { headers: { "X-CSRF-Token": me.csrf } })).ok()).toBeTruthy();
    await ctx.close();
  });

  test("explicit search: an admin allows it, the person turns it on for all devices, the browser searches with LAION", async ({ browser }) => {
    test.setTimeout(300_000);
    // the admin allows it for carol (off by default)
    const actx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    const admin = await actx.newPage();
    await admin.goto("/");
    await admin.getByLabel("E-mail").fill(ADMIN);
    await admin.getByLabel("Password").fill(ADMIN_PW);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await expect(admin.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 30_000 });
    const am = await (await admin.request.get("/api/me")).json();
    const carolId = (await (await admin.request.get("/api/admin/users")).json()).users.find((u: { email: string }) => u.email === CAROL).id;
    const allow = (on: boolean) => admin.request.patch(`/api/admin/users/${carolId}`, { headers: { "X-CSRF-Token": am.csrf }, data: { nsfw: on } });
    expect((await allow(true)).ok()).toBeTruthy();

    const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await signIn(page);
    const me = await (await page.request.get("/api/me")).json();
    const item = (await (await page.request.get("/api/items")).json()).items.find((x: { kind: string }) => x.kind === "image").id;
    await putEntry(page, me, item, "laionb32/1", REF["laion:dog"]); // as an app indexes it after the switch

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await page.getByText("Search", { exact: true }).click();
    const sw = page.getByRole("switch", { name: "Explicit search" });
    await expect(sw).not.toBeChecked();
    await expect(page.getByText("This applies to all your devices:")).toBeVisible();
    await sw.check();
    await expect(sw).toBeChecked();
    await expect(page.getByText("1 photo can be found by what is in them")).toBeVisible(); // counted for LAION now

    const search = page.getByLabel("Search your photos");
    await search.fill("dog");
    // the search is debounced, so the library still shows every tile at first; wait for the one result
    await expect(page.locator(".tile")).toHaveCount(1, { timeout: 240_000 }); // the 254 MB model, once
    await expect(page.locator(`.tile[data-id="${item}"]`)).toBeVisible();

    // off again: back to MobileCLIP, which has no vectors here, so nothing is found by content
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await page.getByText("Search", { exact: true }).click();
    await page.getByRole("switch", { name: "Explicit search" }).uncheck();
    await expect(page.getByRole("switch", { name: "Explicit search" })).not.toBeChecked();
    await search.fill("dog");
    await expect(page.locator(".tile")).toHaveCount(0);

    expect((await page.request.delete("/api/index", { headers: { "X-CSRF-Token": me.csrf } })).ok()).toBeTruthy();
    expect((await allow(false)).ok()).toBeTruthy();
    await ctx.close();
    await actx.close();
  });
});
