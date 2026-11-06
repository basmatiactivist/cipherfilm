import { getBytes, postForBytes } from "./api";
import { getSodium } from "./crypto/sodium";
import { decryptPreview, decryptThumb } from "./crypto/item";
import type { Item } from "./items";
import { ThumbBatcher } from "./thumbbatch";

/** Decrypted images are kept as object URLs in small LRU caches and revoked when evicted or on sign-out. */
class UrlCache {
  private m = new Map<string, string>();
  constructor(private max: number) {}
  get(id: string): string | undefined {
    const u = this.m.get(id);
    if (u) { this.m.delete(id); this.m.set(id, u); }
    return u;
  }
  set(id: string, url: string) {
    this.m.set(id, url);
    while (this.m.size > this.max) {
      const [oldId, oldUrl] = this.m.entries().next().value as [string, string];
      this.m.delete(oldId);
      URL.revokeObjectURL(oldUrl);
    }
  }
  clear() { this.m.forEach((u) => URL.revokeObjectURL(u)); this.m.clear(); }
}

const thumbs = new UrlCache(600);
const previews = new UrlCache(24);
const inflight = new Map<string, Promise<string>>();
let generation = 0; // a sign-out clears the caches; images still loading then are not kept

let active = 0;
const waiters: (() => void)[] = [];
// How many tiles still want an image. A queued job nobody wants any more (the tile scrolled away) is skipped.
const interest = new Map<string, number>();
export const wantImage = (kind: "thumb" | "preview", id: string) => interest.set(kind + id, (interest.get(kind + id) ?? 0) + 1);
export const dropImage = (kind: "thumb" | "preview", id: string) => interest.set(kind + id, Math.max(0, (interest.get(kind + id) ?? 0) - 1));
async function limited<T>(fn: () => Promise<T>, wanted: () => boolean): Promise<T> {
  if (active >= 12) await new Promise<void>((r) => waiters.push(r));
  if (!wanted()) { waiters.pop()?.(); throw new Error("cancelled"); }
  active++;
  try { return await fn(); } finally { active--; waiters.pop()?.(); } // newest request first: what is on screen now
}

// thumbnails go out many to a request; one at a time against an older server
const batcher = new ThumbBatcher((ids) => postForBytes("/api/items/thumbs", { item_ids: ids }), (id, wanted) => limited(() => getBytes(`/api/items/${id}/thumb`), wanted));

export const cachedThumb = (id: string) => thumbs.get(id);
export const cachedPreview = (id: string) => previews.get(id);

// The encrypted thumbnails and previews, exactly as the server sends them, are kept in the browser's Cache Storage, so
// the next visit shows the grid, and paging back in the lightbox shows the photo, without downloading it again. They
// open only with keys held in memory; lock and sign-out delete them. Previews are bigger, so theirs is capped (LRU).
const STORED = { thumb: "cf-thumbs-v1", preview: "cf-previews-v1" } as const;
const PREVIEW_CAP = 300 * 1024 * 1024;
const storedUrl = (kind: "thumb" | "preview", id: string) => `/ct/${kind}/${id}`;
const INDEX = "/ct/preview-index"; // [id, bytes] pairs, least recently used first

const opened = new Map<string, Promise<Cache>>(); // each cache is opened once, not for every image
function box(kind: "thumb" | "preview"): Promise<Cache> {
  let c = opened.get(STORED[kind]);
  if (!c) {
    c = caches.open(STORED[kind]);
    opened.set(STORED[kind], c);
    c.catch(() => opened.delete(STORED[kind]));
  }
  return c;
}

let lru: Promise<Map<string, number>> | null = null;
function previewIndex(): Promise<Map<string, number>> {
  return (lru ??= (async () => {
    try {
      const r = await (await box("preview")).match(INDEX);
      if (r) return new Map<string, number>(await r.json());
    } catch { /* damaged: started over below */ }
    // no index (first use, or it was lost): whatever is stored can't be counted against the cap, so it goes
    opened.delete(STORED.preview);
    await caches.delete(STORED.preview).catch(() => {});
    return new Map<string, number>();
  })());
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function touch(m: Map<string, number>, id: string, bytes: number) {
  m.delete(id); m.set(id, bytes);
  const gen = generation;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (gen === generation) box("preview").then((c) => c.put(INDEX, new Response(JSON.stringify([...m])))).catch(() => {}); }, 1000);
}

async function stored(kind: "thumb" | "preview", id: string): Promise<Uint8Array | null> {
  try {
    const r = await (await box(kind)).match(storedUrl(kind, id));
    if (!r) return null;
    const ct = new Uint8Array(await r.arrayBuffer());
    if (kind === "preview") touch(await previewIndex(), id, ct.length);
    return ct;
  } catch { return null; }
}
async function store(kind: "thumb" | "preview", id: string, ct: Uint8Array, gen: number) {
  try {
    const m = kind === "preview" ? await previewIndex() : null;
    const c = await box(kind);
    if (gen !== generation) return; // locked or signed out meanwhile: its cache was deleted and stays so
    await c.put(storedUrl(kind, id), new Response(ct as BlobPart));
    if (!m) return;
    touch(m, id, ct.length);
    let total = 0;
    m.forEach((n) => { total += n; });
    for (const [old, n] of m) {
      if (total <= PREVIEW_CAP || old === id) break;
      m.delete(old); total -= n;
      void c.delete(storedUrl("preview", old));
    }
  } catch { /* only a cache */ }
}

function load(kind: "thumb" | "preview", cache: UrlCache, it: Item, wanted?: () => boolean): Promise<string> {
  const hit = cache.get(it.id);
  if (hit) return Promise.resolve(hit);
  const key = kind + it.id;
  let p = inflight.get(key);
  if (!p) {
    const gen = generation;
    p = (async () => {
      const s = await getSodium();
      const open = (ct: Uint8Array) => (kind === "thumb" ? decryptThumb : decryptPreview)(s, ct, it.itemKey!, it.id);
      let plain: Uint8Array | null = null;
      const kept = await stored(kind, it.id);
      if (kept) try { plain = open(kept); } catch { /* damaged copy: fetched again */ }
      if (!plain) {
        const ct = kind === "thumb"
          ? await batcher.get(it.id, () => gen === generation && (wanted ?? (() => (interest.get(key) ?? 0) > 0))())
          : await limited(() => getBytes(`/api/items/${it.id}/preview`), () => gen === generation);
        plain = open(ct); // only verified ciphertext is kept
        if (gen === generation) void store(kind, it.id, ct, gen);
      }
      if (gen !== generation) throw new Error("cancelled");
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: "image/jpeg" }));
      cache.set(it.id, url);
      return url;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export const thumbUrl = (it: Item) => load("thumb", thumbs, it);
export const previewUrl = (it: Item) => load("preview", previews, it);

/** The newest thumbnails, fetched ahead after the library loads, so the grid has them before it asks. */
export function prefetchThumbs(items: Item[]) {
  const want = items.filter((it) => it.has_thumb && !it.broken && it.itemKey).slice(0, 400);
  // queued oldest first: the batcher sends the latest request first
  for (const it of want.reverse()) load("thumb", thumbs, it, () => true).catch(() => {});
}
export function clearCaches() {
  generation++;
  thumbs.clear(); previews.clear();
  opened.clear(); lru = null; clearTimeout(saveTimer);
  if (typeof caches !== "undefined") for (const name of Object.values(STORED)) caches.delete(name).catch(() => {});
}
