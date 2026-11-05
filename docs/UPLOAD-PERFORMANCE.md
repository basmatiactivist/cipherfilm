# Upload performance

How the browser uploads a file: it makes a thumbnail and a larger preview, encrypts the original in 4 MiB parts and PUTs each part. Since commit "Faster upload" three files are in flight at once, up to three parts per file, and the thumbnails are made while the parts upload. Before that everything ran one step after the other.

Benchmark: `BENCH=<label> [LATENCY=<ms>] make bench` imports 40 small photos (about 13 KB each) and one 24 MB file into the admin's library on the e2e stack (run `make e2e` first) and prints the time. `LATENCY` adds a simulated round-trip time to every API request (the dev stack itself is on the same machine, so its real latency is about zero). Headless Chromium, OrbStack, one run each, no repeats: treat the numbers as an indication.

| Run | 40 small photos | 24 MB file |
|---|---|---|
| sequential, no added latency | 74 ms per photo | 9.7 MB/s |
| parallel, no added latency | 23 ms per photo | 9.9 MB/s |
| sequential, 60 ms added latency | 425 ms per photo | 7.1 MB/s |
| parallel, 60 ms added latency | 98 ms per photo | 9.7 MB/s |

What this says:
- Many small photos are limited by round trips; running three at a time makes them about 3 to 4 times faster, more with a slower link.
- **The 10 MB/s for the 24 MB file was a measuring error, not the app.** Diagnosed on 2026-11-02 against the
  self-contained e2e stack (app behind Caddy with HTTPS):
  - The server path is fast: 6 PUTs of 4 MiB straight from Node reach 430 MB/s through Caddy (780 MB/s with three
    in parallel) and 600 to 850 MB/s directly to the app. A 4 MiB write with fsync on the volume takes about 3 ms.
  - Measured inside the page, from choosing the file to the finalize response (encrypting, uploading, thumbnail,
    metadata): **Firefox 214 MB/s, WebKit (Safari's engine) 144 MB/s**.
  - Headless Chromium under Playwright is stuck at about 32 MB/s for any upload, also for raw `fetch` PUTs, with
    HTTP/2 or HTTP/1.1, one or six at a time. Firefox and WebKit under the same tool do 180 to 360 MB/s for the same
    raw PUTs. So the limit is in the automated Chromium, most likely the test tool recording every request body.
    A normal Chrome could not be measured here without that tool; that number is still open.
  - The rest of the old wall-clock time was the test tool handing the 24 MB file to the browser.
  - `make bench` now reports the in-page time, and `BROWSER=firefox` or `BROWSER=webkit` picks the engine.
- Image decoding and the two JPEG encodes now run in a worker (`media.worker.ts`, used for images the browser decodes itself; HEIC and video frames stay on the main path, and any worker failure falls back to it). Measured with eight 12-megapixel JPEGs in headless Chromium: 0.82 s and 149 ms of blocked main thread without the worker, 0.71 s and 142 ms with it. No meaningful difference there, because Chromium already decodes and encodes images off the main thread. The worker is kept for browsers where that is not so (Safari and Firefox on phones); that benefit is not measured. Setting `localStorage["cf-noworker"]="1"` turns it off for comparison.
- Not done: sending the thumbnail and preview in one request.
- Not measured: a real Tailscale link, real photos, thousands of files.
