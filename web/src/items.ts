import { api, getBytes, putBytes } from "./api";
import { getSodium, b64, unb64, Sodium } from "./crypto/sodium";
import { cipherLen, decryptSegment, encryptSegment, segmentCount, segmentPlainLen, SEG_PLAIN } from "./crypto/file";
import { accountKeyPair, decryptMeta, encryptMeta, encryptPreview, encryptThumb, newItemKey, unwrapAnyItemKey, unwrapItemKey, wrapItemKey, type KeyPair } from "./crypto/item";
import { normEmail } from "./crypto/account";
import { decodeImage, decodeVideoFrame, ItemMeta, kindOf, PREVIEW_PX, readMeta, THUMB_PX, thumbsInWorker, toJpeg } from "./media";
import { mem } from "./state";

export interface Item {
  id: string;
  kind: "image" | "video" | "other";
  size: number;
  segment_count: number;
  created_at: number;
  has_thumb: boolean;
  has_preview: boolean;
  meta?: ItemMeta;
  itemKey?: Uint8Array;
  /** Decryption or verification failed: never shown, the UI says so. */
  broken?: boolean;
  trashed_at?: number;
  purge_at?: number;
  favorite?: boolean;
}

const need = () => {
  if (!mem.masterKey) throw new Error("Unlock your library first.");
  return mem.masterKey;
};

// what was decrypted already, by id: a reload of the list (every few seconds during an upload) decrypts only items
// that are new or whose key or metadata changed; dropped at every lock and sign-out (it holds item keys)
let known = new Map<string, { wrapped: string; meta: string; master: Uint8Array; item: Item }>();
export function forgetDecrypted() {
  for (const k of known.values()) k.item.itemKey?.fill(0);
  known = new Map();
}

/** Decrypted metadata comes from whichever client uploaded the item: fields the app relies on get the expected type
 *  (an unexpected one is replaced, not trusted), and anything that isn't an object at all marks the item unreadable. */
function wellFormed(m: ItemMeta, createdAt: number): ItemMeta {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("bad metadata");
  if (typeof m.name !== "string") m.name = "item";
  if (typeof m.mime !== "string") m.mime = "";
  if (!Number.isFinite(m.capture_ts)) m.capture_ts = Number.isFinite(m.lastModified) ? m.lastModified : createdAt * 1000;
  return m;
}

function decryptRecords(s: Sodium, raw: any[]): Item[] {
  const master = need();
  // items from the phone's background backup carry keys sealed to the account key pair, opened only if there are any
  let pair: KeyPair | undefined;
  const keyPair = () => (pair ??= accountKeyPair(s, unb64(s, mem.me!.wrapped_privkey), master, normEmail(mem.me!.user.email)));
  const items = raw.map((x): Item => {
    const it: Item = { id: x.id, kind: x.kind, size: x.size, segment_count: x.segment_count, created_at: x.created_at, has_thumb: x.has_thumb, has_preview: x.has_preview, trashed_at: x.trashed_at, purge_at: x.purge_at, favorite: !!x.favorite };
    const k = known.get(x.id);
    if (k && k.master === master && k.wrapped === x.wrapped_item_key && k.meta === x.meta_enc) {
      // the same record: keep what was decrypted, take the fields that change (favorite, thumbnail, trash) anew
      const same = k.item;
      if (same.favorite === it.favorite && same.has_thumb === it.has_thumb && same.has_preview === it.has_preview && same.trashed_at === it.trashed_at && same.purge_at === it.purge_at) return same;
      const next = { ...it, itemKey: same.itemKey, meta: same.meta, broken: same.broken };
      known.set(x.id, { ...k, item: next });
      return next;
    }
    try {
      it.itemKey = unwrapAnyItemKey(s, unb64(s, x.wrapped_item_key), master, keyPair, x.id);
      it.meta = wellFormed(decryptMeta<ItemMeta>(s, unb64(s, x.meta_enc), it.itemKey, x.id), x.created_at);
      if (it.meta.size !== it.size) throw new Error("size mismatch");
    } catch {
      it.broken = true;
    }
    if (!it.broken) known.set(x.id, { wrapped: x.wrapped_item_key, meta: x.meta_enc, master, item: it });
    return it;
  });
  if (pair) s.memzero(pair.sk);
  items.sort((a, b) => (b.meta?.capture_ts ?? b.created_at * 1000) - (a.meta?.capture_ts ?? a.created_at * 1000));
  return items;
}

/** The server sends a list page by page; this follows its `next` cursor to the end. */
async function allPages<T extends { items: any[]; next?: string }>(path: string): Promise<T> {
  const first = await api<T>("GET", path);
  for (let next = first.next; next; ) {
    const page = await api<T>("GET", `${path}?after=${encodeURIComponent(next)}`);
    first.items.push(...page.items);
    next = page.next;
  }
  return first;
}

export async function loadItems(): Promise<{ items: Item[]; quotaLeft: number; unlimited: boolean }> {
  const s = await getSodium();
  const r = await allPages<{ items: any[]; next?: string; quota_left: number; unlimited: boolean }>("/api/items");
  return { items: decryptRecords(s, r.items), quotaLeft: r.quota_left, unlimited: r.unlimited };
}

export async function loadTrash(): Promise<{ items: Item[]; retentionDays: number }> {
  const s = await getSodium();
  const r = await allPages<{ items: any[]; next?: string; retention_days: number }>("/api/trash");
  return { items: decryptRecords(s, r.items), retentionDays: r.retention_days };
}

/** The server takes at most 500 ids per request: a bigger selection (Select all on a large library) goes in batches. */
export const BATCH = 500;
export async function inBatches(ids: string[], send: (part: string[]) => Promise<unknown>) {
  for (let i = 0; i < ids.length; i += BATCH) await send(ids.slice(i, i + BATCH));
}
export const trashItems = (ids: string[]) => inBatches(ids, (part) => api("POST", "/api/items/trash", { item_ids: part }));
export const restoreItems = (ids: string[]) => inBatches(ids, (part) => api("POST", "/api/items/restore", { item_ids: part }));
export const setFavorite = (ids: string[], favorite: boolean) => inBatches(ids, (part) => api("POST", "/api/items/favorite", { item_ids: part, favorite }));
/** Deletes exactly these trashed items permanently, in batches the server accepts. Emptying the trash passes the ids
 *  that are on screen, so an item trashed on another device in the meantime is not deleted unseen. */
export async function purgeTrash(ids: string[]): Promise<number> {
  let removed = 0;
  await inBatches(ids, async (part) => { removed += (await api<{ removed: number }>("POST", "/api/trash/purge", { item_ids: part })).removed; });
  return removed;
}

/** Decrypt every segment into memory. Fine for photos; the streaming path for large files comes with video/ZIP. */
export async function fetchOriginal(it: Item, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const s = await getSodium();
  const parts: BlobPart[] = [];
  for (let i = 0; i < it.segment_count; i++) {
    const ct = await getBytes(`/api/items/${it.id}/segments/${i}`);
    parts.push(decryptSegment(s, it.itemKey!, it.id, i, it.segment_count, it.size, ct) as BlobPart);
    onProgress?.(i + 1, it.segment_count);
  }
  // only ever saved or zipped, never shown: the stored type is not needed and not trusted
  return new Blob(parts, { type: "application/octet-stream" });
}

// ---- upload ----

/** Parts of one file that are in flight at the same time. */
export const SEGMENTS_IN_FLIGHT = 3;

interface Pending { id: string; wrapped: string }

/** An upload the person cancelled. */
export class Cancelled extends Error {
  constructor() { super("Cancelled."); }
}

/** Throws away what a cancelled upload already sent, and its note for resuming. Only while the account that started
 *  it is signed in: its notes went at sign-out, and the server would not let another account delete its parts. */
export async function discardUpload(f: File, owner: string): Promise<void> {
  if (mem.me?.user.id !== owner) return;
  const p = readPending(owner, f);
  savePending(owner, f, null);
  if (p) await api("DELETE", `/api/items/${p.id}`).catch(() => {});
}

/** An upload stopped because the account that started it signed out. */
export class SignedOut extends Error {
  constructor() { super("Stopped: you signed out."); }
}
/** Item ids are 32 lowercase hex characters; anything else from the server is refused before a key is bound to it. */
export const isItemId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id);

// the note is filed under the account that started the upload, never under whoever is signed in when it is written
const pendingKey = (owner: string, f: File) => `cf-upload:${owner}:${f.name}:${f.size}:${f.lastModified}`;
const readPending = (owner: string, f: File): Pending | null => {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey(owner, f)) ?? "null");
    return p && isItemId(p.id) && typeof p.wrapped === "string" ? p : null;
  } catch { return null; }
};
const savePending = (owner: string, f: File, p: Pending | null) => {
  try { p ? localStorage.setItem(pendingKey(owner, f), JSON.stringify(p)) : localStorage.removeItem(pendingKey(owner, f)); } catch { /* storage unavailable: resume across reloads is simply off */ }
};

/**
 * Encrypts a file in the browser and uploads it segment by segment. Safe to call again for the same
 * file after a failure or a reload: segments the server already has are skipped.
 */
export async function uploadFile(f: File, onProgress: (done: number, total: number) => void, stop?: { cancelled: boolean }): Promise<string> {
  const s = await getSodium();
  const master = need();
  // bound to the session that started it: after a sign-out (and maybe someone else's sign-in in this tab) it stops.
  // A cancelled upload stops at the next part as well.
  const owner = mem.me!.user.id;
  const signedIn = () => {
    if (mem.me?.user.id !== owner || mem.masterKey !== master) throw new SignedOut();
  };
  const mine = () => {
    if (stop?.cancelled) throw new Cancelled();
    signedIn();
  };
  const kind = kindOf(f);
  const count = segmentCount(f.size);

  let id: string;
  let itemKey: Uint8Array;
  let wrapped: string;
  let received = new Set<number>();
  let hasThumb = false;

  const prev = readPending(owner, f);
  let resumed = false;
  if (prev) {
    try {
      const st = await api<{ state: string; size: number; segment_count: number; received: number[]; has_thumb: boolean }>("GET", `/api/items/${prev.id}/upload`);
      if (st.state === "uploading" && st.size === f.size) {
        id = prev.id;
        wrapped = prev.wrapped;
        itemKey = unwrapItemKey(s, unb64(s, wrapped), master, id);
        received = new Set(st.received);
        hasThumb = st.has_thumb;
        resumed = true;
      }
    } catch { /* server forgot it: start over */ }
  }
  mine();
  if (!resumed) {
    id = (await api<{ id: string }>("POST", "/api/items", { kind, size: f.size, segment_count: count })).id;
    signedIn(); // the account may have changed while the server answered: then no note is written at all
    if (!isItemId(id)) throw new Error("The server sent an unexpected item id. The upload was stopped.");
    itemKey = newItemKey(s);
    wrapped = b64(s, wrapItemKey(s, itemKey, master, id));
    savePending(owner, f, { id, wrapped });
  }
  id = id!; itemKey = itemKey!; wrapped = wrapped!;

  // Thumbnails are made while the segments upload: the two do not depend on each other. A file the browser
  // cannot decode still uploads, just without a thumbnail.
  let dims: { width: number; height: number; duration?: number } | undefined;
  const thumbWork = (async () => {
    if ((kind !== "image" && kind !== "video") || hasThumb) return;
    try {
      const made = await thumbsInWorker(f);
      if (made) {
        dims = { width: made.width, height: made.height };
        mine();
        await Promise.all([putBytes(`/api/items/${id}/thumb`, encryptThumb(s, made.thumb, itemKey, id)), putBytes(`/api/items/${id}/preview`, encryptPreview(s, made.preview, itemKey, id))]);
        return;
      }
      const d = kind === "video" ? await decodeVideoFrame(f) : await decodeImage(f);
      dims = { width: d.width, height: d.height, duration: d.duration };
      const thumb = encryptThumb(s, await toJpeg(d, THUMB_PX, 0.82), itemKey, id);
      const preview = encryptPreview(s, await toJpeg(d, PREVIEW_PX, 0.85), itemKey, id);
      d.close();
      mine();
      await Promise.all([putBytes(`/api/items/${id}/thumb`, thumb), putBytes(`/api/items/${id}/preview`, preview)]);
    } catch (e) { console.warn("thumbnail failed:", e); }
  })();

  const total = f.size || 1;
  let done = received.size ? Math.min(f.size, received.size * SEG_PLAIN) : 0;
  onProgress(done, total);
  // a few segments in flight at once: one round trip per 4 MiB part is what limits a single stream
  const inflight = new Set<Promise<void>>();
  let failure: unknown;
  for (let i = 0; i < count && failure === undefined; i++) {
    if (received.has(i)) continue;
    const len = f.size === 0 ? 0 : segmentPlainLen(f.size, i);
    const plain = new Uint8Array(await f.slice(i * SEG_PLAIN, i * SEG_PLAIN + len).arrayBuffer());
    mine();
    const ct = encryptSegment(s, itemKey, id, i, count, f.size, plain);
    if (ct.length !== cipherLen(len)) throw new Error("internal size error");
    const put: Promise<void> = putBytes(`/api/items/${id}/segments/${i}`, ct)
      .then(() => { done += len; onProgress(Math.min(done, total), total); }, (e) => { failure ??= e; })
      .finally(() => { inflight.delete(put); });
    inflight.add(put);
    if (inflight.size >= SEGMENTS_IN_FLIGHT) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  await thumbWork;
  if (failure !== undefined) throw failure;
  const meta = await readMeta(f, dims);
  mine();
  await api("POST", `/api/items/${id}/finalize`, { wrapped_item_key: wrapped, meta_enc: b64(s, encryptMeta(s, meta, itemKey, id)) });
  savePending(owner, f, null);
  return id;
}

/**
 * Uploads that started but never finished (the tab was closed, reloaded or killed by the phone). Their parts stay
 * on the server for two days; choosing the same file again continues where it stopped.
 */
export function unfinishedUploads(): string[] {
  const prefix = `cf-upload:${mem.me!.user.id}:`;
  const out: string[] = [];
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split(":");
      if (rest.length >= 3) out.push(rest.slice(0, -2).join(":")); // the name may itself contain colons
    }
  } catch { /* storage unavailable */ }
  return out;
}

/** The person does not want to continue them: forget the local note (the server drops the parts after two days). */
export function forgetUnfinished() {
  const prefix = `cf-upload:${mem.me!.user.id}:`;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}

/** Upload-resume entries hold file names in their keys: forget them when the session ends. */
export function clearUploadMemory() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("cf-upload:")) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}
