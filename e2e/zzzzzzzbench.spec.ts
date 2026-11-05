import { expect, test } from "@playwright/test";
import { pw } from "./creds";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Upload benchmark. Skipped in the normal run; start with BENCH=1 (see Makefile target `bench`).
// It imports 40 small photos and one 24 MB file into the admin's empty library and records the wall-clock time.
const png = readFileSync(join(__dirname, "fixtures/sample.png"));

test.skip(!process.env.BENCH, "set BENCH=1 to run the upload benchmark");

test("upload benchmark: 40 small photos and one large file", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  let workerSeen = false;
  page.on("request", (r) => { if (r.url().includes("media.worker")) workerSeen = true; });
  const latency = Number(process.env.LATENCY ?? 0); // simulated round-trip time added to every API request, in ms
  if (latency) await page.route("**/api/**", async (route) => { await new Promise((r) => setTimeout(r, latency)); await route.continue(); });
  await page.goto("/");
  await page.getByLabel("E-mail").fill("admin@example.org");
  await page.getByLabel("Password").fill(pw("admin"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const count = async () => ((await (await page.request.get("/api/items")).json()).items as unknown[]).length; // the grid only keeps visible rows in the DOM
  const before = await count();

  // time the page's main thread was blocked by tasks longer than 50 ms while uploading (UI jank)
  await page.evaluate(() => {
    (window as any).__long = 0; (window as any).__tasks = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { (window as any).__long += e.duration; (window as any).__tasks.push(Math.round(e.duration)); } }).observe({ type: "longtask", buffered: true });
  });
  const small = Array.from({ length: 40 }, (_, i) => ({ name: `bench-${i}.png`, mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from(`#${i}-${Date.now()}`)]) }));
  const t0 = Date.now();
  await page.locator('input[type="file"]').setInputFiles(small);
  await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 300_000 });
  await expect.poll(count, { timeout: 60_000 }).toBe(before + 40);
  const tSmall = Date.now() - t0;

  // time inside the page, from the file input's change event to the finalize response: excludes the test tool
  // handing the 24 MB to the browser, which is slow and not part of the app
  await page.evaluate(() => { performance.clearResourceTimings(); performance.setResourceTimingBufferSize(5000); document.querySelector('input[type="file"]')!.addEventListener("change", () => { (window as any).__chg = performance.now(); }, { capture: true, once: true }); });
  const big = { name: "bench-big.png", mimeType: "image/png", buffer: Buffer.concat([png, randomBytes(24 * 1024 * 1024)]) };
  const t1 = Date.now();
  await page.locator('input[type="file"]').setInputFiles(big);
  await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 300_000 });
  await expect.poll(count, { timeout: 60_000 }).toBe(before + 41);
  const tBig = Date.now() - t1;
  const tBigInPage = Math.round(await page.evaluate(() => {
    const fin = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((e) => e.name.endsWith("/finalize")).pop()!;
    return fin.responseEnd - (window as any).__chg;
  }));

  const tasks: number[] = await page.evaluate(() => (window as any).__tasks);
  console.log("longest main-thread tasks (ms):", [...tasks].sort((a, b) => b - a).slice(0, 8).join(", "), "of", tasks.length);
  console.log("worker requested:", workerSeen);
  // eight 12-megapixel photos: decoding and re-encoding them is what used to block the page
  if (process.env.NOWORKER) await page.evaluate(() => localStorage.setItem("cf-noworker", "1"));
  const photos = await page.evaluate(async () => {
    const out: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = document.createElement("canvas");
      c.width = 4000; c.height = 3000;
      const x = c.getContext("2d")!;
      for (let k = 0; k < 600; k++) { x.fillStyle = `hsl(${Math.random() * 360} 70% ${30 + Math.random() * 40}%)`; x.fillRect(Math.random() * 4000, Math.random() * 3000, 300, 200); }
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.92));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; for (let j = 0; j < bytes.length; j += 8192) bin += String.fromCharCode(...bytes.subarray(j, j + 8192));
      out.push(btoa(bin));
      c.width = c.height = 0;
    }
    return out;
  });
  await page.evaluate(() => { (window as any).__long = 0; (window as any).__tasks = []; });
  const t2 = Date.now();
  await page.locator('input[type="file"]').setInputFiles(photos.map((b, i) => ({ name: `big-photo-${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b, "base64") })));
  await page.waitForTimeout(500);
  await expect(page.locator(".jobs")).toHaveCount(0, { timeout: 300_000 });
  await expect.poll(count, { timeout: 60_000 }).toBe(before + 49);
  const tPhotos = Date.now() - t2;
  const photoTasks: number[] = await page.evaluate(() => (window as any).__tasks);
  const photoBlocked = Math.round(await page.evaluate(() => (window as any).__long));
  console.log("PHOTOS 8x12MP:", tPhotos, "ms; main thread blocked", photoBlocked, "ms; longest tasks:", [...photoTasks].sort((a, b) => b - a).slice(0, 6).join(", "));
  appendFileSync("test-results/bench.txt", `PHOTOS label=${process.env.BENCH} 8x12MP=${tPhotos}ms mainThreadBlocked=${photoBlocked}ms longestTask=${Math.max(0, ...photoTasks)}ms\n`);
  const blocked = Math.round(await page.evaluate(() => (window as any).__long));
  const line = `BENCH label=${process.env.BENCH} latency=${latency}ms small40=${tSmall}ms (${(tSmall / 40).toFixed(0)} ms/photo) browser=${process.env.BROWSER || "chromium"} big24MB=${tBigInPage}ms in page (${(24 / (tBigInPage / 1000)).toFixed(0)} MB/s; ${tBig}ms incl. test tool) mainThreadBlocked=${blocked}ms`;
  console.log(line);
  appendFileSync("test-results/bench.txt", line + "\n");
  await ctx.close();
});
