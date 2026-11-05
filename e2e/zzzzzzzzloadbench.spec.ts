import { expect, Page, test } from "@playwright/test";
import { pw } from "./creds";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load benchmark. Skipped in the normal run; start with LOADBENCH=<label> (see Makefile target `loadbench`).
// On a throttled connection (10 Mbit/s, 60 ms) it times the first thumbnail after a reload, with an empty and with a
// warm HTTP cache, and paging through the lightbox and back. It fills the admin's library to 60 photos first.
const png = readFileSync(join(__dirname, "fixtures/sample.png"));
const TOKEN = process.env.SETUP_TOKEN ?? "";

test.skip(!process.env.LOADBENCH, "set LOADBENCH=<label> to run the load benchmark");

async function firstThumb(page: Page): Promise<number> {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".tile img")].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60_000 });
  return page.evaluate(() => Math.round(performance.now()));
}

test("load benchmark: first thumbnails and lightbox paging", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up Cipherfilm" });
  await expect(setup.or(page.getByRole("button", { name: "Sign in" }))).toBeVisible({ timeout: 30_000 });
  if (await setup.isVisible()) {
    await page.getByLabel("Setup token").fill(TOKEN);
    await page.getByLabel("E-mail").fill("admin@example.org");
    await page.getByLabel("Password", { exact: true }).fill(pw("admin"));
    await page.getByLabel("Repeat password").fill(pw("admin"));
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByLabel(/I've saved my recovery key/).check({ timeout: 60_000 });
    await page.getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByLabel("E-mail").fill("admin@example.org");
    await page.getByLabel("Password").fill(pw("admin"));
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 60_000 });
  const count = async () => ((await (await page.request.get("/api/items")).json()).items as unknown[]).length;
  const have = await count();
  if (have < 60) {
    const files = Array.from({ length: 60 - have }, (_, i) => ({ name: `load-${i}.png`, mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from(`#${i}-${Date.now()}`)]) }));
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 300_000 });
    await expect.poll(count, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
  }

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: 10e6 / 8, uploadThroughput: 5e6 / 8 });
  let js = 0;
  const scripts = new Set<string>();
  cdp.on("Network.responseReceived", (e) => { if (/\.js$/.test(new URL(e.response.url).pathname)) scripts.add(e.requestId); });
  cdp.on("Network.loadingFinished", (e) => { if (scripts.has(e.requestId)) js += e.encodedDataLength; });

  // reload with an empty HTTP cache: the code comes over the network, the encrypted thumbnails from Cache Storage;
  // then with a warm one. Five of each, the median counts.
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const colds: number[] = [], warms: number[] = [];
  let coldJs = 0;
  for (let i = 0; i < 5; i++) {
    await cdp.send("Network.clearBrowserCache");
    js = 0;
    await page.reload();
    colds.push(await firstThumb(page));
    coldJs = js;
    await page.waitForTimeout(500);
    await page.reload();
    warms.push(await firstThumb(page));
    await page.waitForTimeout(500);
  }
  const cold = median(colds), warm = median(warms);

  // lightbox: open the first photo, page 12 forward and 12 back, timing until each preview is on screen
  let previews = 0;
  page.on("request", (r) => { if (/\/api\/items\/[^/]+\/preview/.test(r.url())) previews++; });
  await page.locator(".tile[data-id]").first().click();
  const shown = () => page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>(".lightbox .stage img"); return !!i && i.complete && i.naturalWidth > 0 && i.src.startsWith("blob:"); });
  await shown();
  const step = async (key: string) => {
    const src = await page.locator(".lightbox .stage img").getAttribute("src").catch(() => null);
    const t = Date.now();
    await page.keyboard.press(key);
    await page.waitForFunction((s) => { const i = document.querySelector<HTMLImageElement>(".lightbox .stage img"); return !!i && i.src !== s && i.complete && i.naturalWidth > 0; }, src);
    return Date.now() - t;
  };
  const fwd: number[] = [], back: number[] = [];
  for (let i = 0; i < 12; i++) fwd.push(await step("ArrowRight"));
  const previewsFwd = previews;
  for (let i = 0; i < 12; i++) back.push(await step("ArrowLeft"));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const line = `${process.env.LOADBENCH}: first thumb after reload ${cold} ms (empty HTTP cache, ${Math.round(coldJs / 1024)} KB of JS), ${warm} ms (warm); `
    + `lightbox 12 forward ${sum(fwd)} ms (${previewsFwd} preview fetches), 12 back ${sum(back)} ms (${previews - previewsFwd} preview fetches)\n`;
  console.log(line);
  appendFileSync(join(__dirname, "test-results/loadbench.txt"), line);
  await ctx.close();
});
