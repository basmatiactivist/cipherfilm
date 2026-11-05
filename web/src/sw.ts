// Service Worker: serves /sw/stream/<itemId> by fetching encrypted segments, decrypting them
// in memory and answering HTTP Range requests, so <video> can play and seek without a full download.
// Keys never leave the browser: the page hands them over by message and the worker keeps them in memory only.
import { getSodium, unb64 } from "./crypto/sodium";
import { decryptSegment } from "./crypto/file";
import { parseRange, sliceFor, spanFor } from "./sw-range";
import { makeZip, predictLength } from "client-zip";
import { attachment, dedupe } from "./names";

interface Params { key: string; size: number; count: number; mime: string }
interface Held extends Params { itemKey?: Uint8Array }

const sw: any = self;
const params = new Map<string, Held>();
const cache = new Map<string, Uint8Array>(); // tiny LRU of decrypted segments
const pending = new Map<string, Promise<Uint8Array>>();
const CACHE_MAX = 8;
const AHEAD = 3; // segments fetched ahead of playback: a 4 MB segment per round trip is too slow on a far-away server

interface Entry extends Params { id: string; name: string; mtime: number }
interface Job { kind: "file" | "zip"; name: string; entries: Entry[]; expires: number }
const jobs = new Map<string, Job>(); // download jobs handed over by the page; keys stay in memory only
const JOB_TTL = 10 * 60_000;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (e: any) => e.waitUntil(sw.clients.claim()));
sw.addEventListener("message", (e: any) => {
  if (e.data?.type === "clear") { params.clear(); cache.clear(); pending.clear(); jobs.clear(); }
  if (e.data?.type === "job") {
    for (const [t, j] of jobs) if (j.expires < Date.now()) jobs.delete(t);
    jobs.set(e.data.token, { ...e.data.job, expires: Date.now() + JOB_TTL });
    e.ports[0]?.postMessage("ok");
  }
});

sw.addEventListener("fetch", (event: any) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/sw/stream/")) {
    // media elements only: a top-level navigation or frame must not render decrypted bytes under a stored MIME type
    if (event.request.mode === "navigate" || event.request.destination === "document" || event.request.destination === "iframe") {
      event.respondWith(new Response("not found", { status: 404 }));
      return;
    }
    event.respondWith(serve(event, url));
  }
  else if (url.pathname.startsWith("/sw/dl/")) event.respondWith(download(url));
});

async function askPage(id: string, clientId: string): Promise<Params | null> {
  const c = (clientId && (await sw.clients.get(clientId))) || (await sw.clients.matchAll({ type: "window" }))[0];
  if (!c) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data ?? null); };
    c.postMessage({ type: "need-key", id }, [ch.port2]);
  });
}

async function segment(id: string, p: Held, n: number): Promise<Uint8Array> {
  const k = id + ":" + n;
  const hit = cache.get(k);
  if (hit) { cache.delete(k); cache.set(k, hit); return hit; }
  let job = pending.get(k);
  if (!job) {
    job = (async () => {
      const s = await getSodium();
      p.itemKey ??= unb64(s, p.key);
      const res = await fetch(`/api/items/${id}/segments/${n}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error("segment unavailable");
      const plain = decryptSegment(s, p.itemKey, id, n, p.count, p.size, new Uint8Array(await res.arrayBuffer()));
      cache.set(k, plain);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return plain;
    })().finally(() => pending.delete(k));
    pending.set(k, job);
  }
  return job;
}

async function serve(event: any, url: URL): Promise<Response> {
  const id = url.pathname.slice("/sw/stream/".length);
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response("not found", { status: 404 });
  let p = params.get(id);
  if (!p) {
    const got = await askPage(id, event.clientId);
    if (got) params.set(id, (p = { ...got }));
  }
  if (!p) return new Response("not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": p.mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
    // headers the server sets never reach worker-made responses, so set the relevant ones here
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (p.size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...headers, "Content-Length": "0" } });

  const range = parseRange(event.request.headers.get("Range"), p.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${p.size}` } });
  const r = range ?? { start: 0, end: p.size - 1 };
  const { first, last } = spanFor(r);
  headers["Content-Length"] = String(r.end - r.start + 1);
  if (range) headers["Content-Range"] = `bytes ${r.start}-${r.end}/${p.size}`;

  return new Response(plainStream(id, p, r, first, last), { status: range ? 206 : 200, headers });
}

/** Decrypts segments one at a time and emits the bytes of range r. Any verification failure errors the stream. */
function plainStream(id: string, held: Held, r: { start: number; end: number }, first: number, last: number): ReadableStream<Uint8Array> {
  let seg = first;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (seg > last) return ctl.close();
      try {
        const plain = await segment(id, held, seg);
        for (let k = 1; k <= AHEAD && seg + k <= last; k++) segment(id, held, seg + k).catch(() => {}); // read ahead
        const [a, b] = sliceFor(seg, r, plain.length);
        ctl.enqueue(plain.slice(a, b));
        seg++;
      } catch (e) {
        ctl.error(e);
      }
    },
  });
}

const wholeFile = (e: Entry): ReadableStream<Uint8Array> =>
  e.size === 0
    ? new ReadableStream({ start: (c) => c.close() })
    : plainStream(e.id, e, { start: 0, end: e.size - 1 }, 0, e.count - 1);

/** /sw/dl/<token>: a single original, or a ZIP of several, streamed out as a download with bounded memory. */
async function download(url: URL): Promise<Response> {
  const found = jobs.get(url.pathname.slice("/sw/dl/".length));
  if (!found || found.expires < Date.now()) return new Response("not found", { status: 404 });
  const job: Job = found;
  const base = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (job.kind === "file") {
    const e = job.entries[0];
    return new Response(wholeFile(e), { headers: { ...base, "Content-Type": "application/octet-stream", "Content-Length": String(e.size), "Content-Disposition": attachment(e.name) } });
  }
  const names = dedupe(job.entries.map((e) => e.name));
  const meta = job.entries.map((e, i) => ({ name: names[i], size: e.size, lastModified: new Date(e.mtime) }));
  async function* files() {
    for (let i = 0; i < job.entries.length; i++) yield { ...meta[i], input: wholeFile(job.entries[i]) };
  }
  return new Response(makeZip(files(), { metadata: meta }), {
    headers: { ...base, "Content-Type": "application/zip", "Content-Length": String(predictLength(meta)), "Content-Disposition": attachment(job.name) },
  });
}
