import { expect, test, Page } from "@playwright/test";
import sodium from "libsodium-wrappers-sumo";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pw } from "./creds";

// Search by what is in a photo: the Android or Mac app stores an image vector per photo in the index, sealed to the
// account's public key. Here two photos get the text vectors of "dog" and "city at night" (LAION's ViT-B/32, the one
// search model) from the Python reference (onnxruntime 1.31.1) as their image vectors, a third a random one. The
// browser downloads the real text model from Hugging Face, turns the typed words into a vector in its worker and must rank the right photo first.
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
    // the third: half of each, fixed (a random vector sometimes looks explicit to the search's filter and is left out)
    const mix = REF["dog"].map((x, i) => x + REF["city at night"][i]);
    const norm = Math.hypot(...mix);
    for (const [i, v] of [REF["dog"], REF["city at night"], mix.map((x) => x / norm)].entries()) await putEntry(page, me, items[i].id, "laionb32/1", v);

    // a fresh sign-in reads the index; the settings say what can be searched
    await page.reload(); // stays unlocked: the tab keeps the key across a reload (web/src/keep.ts)
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    const all = await page.locator(".tile").count();
    const search = page.getByLabel("Search your photos");
    // nothing goes to Hugging Face before the yes (docs/MODELS.md): the first search asks
    const hf: string[] = [];
    page.on("request", (r) => { if (/^https:\/\/([\w-]+\.)*(huggingface\.co|hf\.co)\//.test(r.url())) hf.push(r.url()); });
    await search.fill("dog");
    await expect(page.getByRole("heading", { name: "Download the search model?" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("the public site where these open models are published", { exact: false })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(hf).toEqual([]);
    await page.getByRole("button", { name: "Download and turn on" }).click();
    // ranked like Immich: every photo with a vector, best match first, no day headings; photos without one don't show
    await expect(page.locator(".tile")).toHaveCount(3, { timeout: 240_000 }); // the first search downloads the 258 MB model
    expect(hf.length).toBeGreaterThan(0);
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
    await expect(page.getByText(/Search model downloaded on .*, \d+ MB\./)).toBeVisible();
    await expect(page.getByRole("switch", { name: "Explicit search" })).toHaveCount(0); // not allowed for carol

    // leave carol's library as it was
    expect((await page.request.delete("/api/index", { headers: { "X-CSRF-Token": me.csrf } })).ok()).toBeTruthy();
    await ctx.close();
  });

  test("explicit content: filtered unless an admin allows explicit search and the person chooses it, for all devices", async ({ browser }) => {
    test.setTimeout(300_000);
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

    const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await signIn(page);
    const me = await (await page.request.get("/api/me")).json();
    const items = (await (await page.request.get("/api/items")).json()).items.filter((x: { kind: string }) => x.kind === "image").slice(0, 2);
    // the second photo's vector is the explicit concept "a photo of a naked person" itself (server/explicit-filter.json)
    const filter = JSON.parse(readFileSync(join(__dirname, "..", "server", "explicit-filter.json"), "utf8"));
    const hv = Buffer.from(filter.concepts.find((c: { text: string }) => c.text === "a photo of a naked person").vec.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const explicitVec = Array.from({ length: 512 }, (_, i) => {
      const h = hv.readUInt16LE(2 * i), e = (h >> 10) & 31, m = h & 1023, sg = h & 0x8000 ? -1 : 1;
      return e ? sg * (1 + m / 1024) * 2 ** (e - 15) : sg * m * 2 ** -24;
    });
    await putEntry(page, me, items[0].id, "laionb32/1", REF["dog"]);
    await putEntry(page, me, items[1].id, "laionb32/1", explicitVec);
    await page.reload();
    await expect(page.locator(".tile").first()).toBeVisible({ timeout: 30_000 });
    const search = page.getByLabel("Search your photos");
    await search.fill("dog");
    const ok = page.getByRole("button", { name: "Download and turn on" });
    if (await ok.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await ok.click(); // a new browser: asked first
    // filtered: the explicit photo is left out, and explicit words find nothing
    await expect(page.locator(".tile")).toHaveCount(1, { timeout: 240_000 });
    await expect(page.locator(`.tile[data-id="${items[0].id}"]`)).toBeVisible();
    await search.fill("nude");
    await expect(page.locator(".tile")).toHaveCount(0, { timeout: 30_000 });

    // the admin allows it and carol turns it on: everything is found, nothing is indexed again
    expect((await allow(true)).ok()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await page.getByText("Search", { exact: true }).click();
    const sw = page.getByRole("switch", { name: "Explicit search" });
    await expect(sw).not.toBeChecked();
    await sw.check();
    await expect(sw).toBeChecked();
    await search.fill("dog");
    await expect(page.locator(".tile")).toHaveCount(2, { timeout: 60_000 });
    // off again: filtered again, and the index stays
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    await page.getByText("Search", { exact: true }).click();
    await page.getByRole("switch", { name: "Explicit search" }).uncheck();
    await search.fill("dog");
    await expect(page.locator(".tile")).toHaveCount(1, { timeout: 60_000 });
    expect((await (await page.request.get("/api/index?model=laionb32")).json()).entries).toHaveLength(2);

    expect((await page.request.delete("/api/index", { headers: { "X-CSRF-Token": me.csrf } })).ok()).toBeTruthy();
    expect((await allow(false)).ok()).toBeTruthy();
    await ctx.close();
    await actx.close();
  });
});
