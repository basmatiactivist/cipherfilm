// The person's library: the server's list, decrypted on the phone. Previews are decrypted into memory only (data: URIs,
// memory cache); the grid's thumbnails are fetched, decrypted and shown natively (Thumbs.kt), which gets the item keys
// while the library is unlocked. Nothing decrypted is written to storage.
//
// For a fast start the app keeps the server's own ciphertext in its cache folder: the item list (wrapped keys,
// encrypted names) and the encrypted thumbnails and previews. They open only with the master key, which exists in
// memory only, so a cached copy reveals no more than the server's copy does. Sign-out removes it.
import { Directory, File, Paths } from "expo-file-system";
import { getSodium, unb64, type Sodium } from "@crypto/sodium";
import { accountKeyPair, decryptMeta, decryptPreview, decryptThumb, unwrapAnyItemKey, type KeyPair } from "@crypto/item";
import { normEmail } from "@crypto/account";
import N from "../modules/cf-native/src/CfNativeModule";
import { api, csrfToken, getBytes, postForBytes, server } from "./api";
import { onWipe, session } from "./session";
import { t } from "./i18n";
import { ThumbBatcher } from "./thumbbatch";
import { kindOf } from "./kind";
import { ListSync, type Page } from "./sync";
import { normEdit, normOrig, pictureKey, type Edit, type Orig } from "@edit/edit";
import { SHA256_HEX } from "@crypto/sha256";
import { HighWater, metaVersion } from "@crypto/metaVersion";

export interface ItemMeta {
  name: string; mime: string; size: number; lastModified: number; capture_ts: number;
  width?: number; height?: number; duration?: number; make?: string; model?: string; gps?: { lat: number; lon: number };
  /** turned and cropped (@edit/edit); the encrypted original stays as it was */
  edit?: Edit;
  /** the date and place before the person changed them */
  orig?: Orig;
  /** SHA-256 of the original file, 64 lowercase hex characters (newer uploads only; docs/CRYPTO.md) */
  sha256?: string;
  /** the metadata's version, raised by every change of it (@crypto/metaVersion); none: 0 */
  mv?: number;
}

/** What an edit says is checked like the rest: what doesn't make sense is dropped, not trusted. */
export function checkedMeta(m: ItemMeta): ItemMeta {
  const edit = normEdit(m.edit), orig = normOrig(m.orig);
  if (edit) m.edit = edit; else delete m.edit;
  if (orig) m.orig = orig; else delete m.orig;
  if (Number.isFinite(m.capture_ts)) m.capture_ts = Math.round(m.capture_ts);
  if (m.sha256 !== undefined && !(typeof m.sha256 === "string" && SHA256_HEX.test(m.sha256))) delete m.sha256;
  if (m.mv !== undefined && metaVersion(m) !== m.mv) delete m.mv;
  return m;
}

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
  /** the wrapped item key as the server handed it out (base64): whether this phone made it (ownUploads.ts) */
  wrapped?: string;
  /** Decryption or verification failed: never shown, the screen says so. */
  broken?: boolean;
  /** The server gave an older version of the metadata than this phone saw before (@crypto/metaVersion) and the newer
   *  one isn't known here any more: shown, but never shared or saved as the original by default (outbox.ts). */
  stale?: boolean;
  /** in the trash: when it was moved there and when the server deletes it permanently (seconds) */
  trashed_at?: number;
  purge_at?: number;
  favorite?: boolean;
}

// what was decrypted already, by id: the server's list after the cached one (and every reload after an upload)
// decrypts only what is new or changed instead of the whole library again; dropped at every lock and sign-out
let known = new Map<string, { w: string; m: string; master: Uint8Array; key?: Uint8Array; meta?: ItemMeta }>();

// the highest metadata version seen of each item (@crypto/metaVersion), per account, in the app's private files (item
// ids and numbers only); kept across locks, deleted at sign-out
const VERSIONS = () => new Directory(Paths.document, "cf-mv");
let versions: { owner: string; hw: HighWater } | null = null;
function highWater(owner: string): HighWater {
  if (versions?.owner !== owner) {
    const f = new File(VERSIONS(), `${owner}.json`);
    let loaded: unknown = null;
    try { if (f.exists) loaded = JSON.parse(f.textSync()); } catch { /* unreadable: started anew */ }
    versions = {
      owner,
      hw: new HighWater((e) => {
        try { VERSIONS().create({ intermediates: true, idempotent: true }); f.write(JSON.stringify(e)); } catch { /* this run only */ }
      }, loaded),
    };
  }
  return versions.hw;
}

function decrypt(s: Sodium, master: Uint8Array, pair: () => KeyPair, x: any, hw?: HighWater): Item {
  const it: Item = { id: x.id, kind: x.kind, size: x.size, segment_count: x.segment_count, created_at: x.created_at, has_thumb: x.has_thumb, has_preview: x.has_preview, trashed_at: x.trashed_at, purge_at: x.purge_at, favorite: !!x.favorite, wrapped: x.wrapped_item_key };
  const k = known.get(x.id);
  if (k && k.master === master && k.w === x.wrapped_item_key && k.m === x.meta_enc && k.key && k.meta && k.meta.size === x.size) {
    it.itemKey = k.key; it.meta = k.meta; it.kind = kindOf(k.meta);
    return it;
  }
  try {
    it.itemKey = unwrapAnyItemKey(s, unb64(s, x.wrapped_item_key), master, pair, x.id);
    it.meta = checkedMeta(decryptMeta<ItemMeta>(s, unb64(s, x.meta_enc), it.itemKey, x.id));
    if (it.meta.size !== it.size) throw new Error("size mismatch");
    it.kind = kindOf(it.meta);
    if (hw && !hw.check(x.id, metaVersion(it.meta))) {
      // an older version of the metadata than seen before: the server handed out a copy it kept (a removed place
      // back, an edit undone). The newer one decrypted since the last lock stays; without it the item is stale.
      console.warn(`Cipherfilm: the server sent older metadata for item ${x.id} (version ${metaVersion(it.meta)}, seen ${hw.highest(x.id)}); keeping the newer one.`);
      if (k?.meta && k.key && k.master === master && metaVersion(k.meta) > metaVersion(it.meta)) { it.meta = k.meta; it.itemKey = k.key; it.wrapped = k.w; it.kind = kindOf(k.meta); }
      else it.stale = true;
      return it;
    }
    // turned or cropped on some device since: the pictures kept here are the old ones
    if (k?.meta && pictureKey(x.id, k.meta) !== pictureKey(x.id, it.meta)) forgetPictures(x.id);
    known.set(x.id, { w: x.wrapped_item_key, m: x.meta_enc, master, key: it.itemKey, meta: it.meta });
  } catch {
    it.broken = true;
  }
  return it;
}

export const when = (it: Item) => it.meta?.capture_ts ?? it.created_at * 1000;

// ---- the encrypted copy on this phone ----

const ID = /^[0-9a-f]{32}$/;
const ROOT = () => new Directory(Paths.cache, "cf-ct");
function userDir(): Directory | null {
  const id = session().me?.user.id;
  return id && /^[0-9A-Za-z_-]{1,64}$/.test(id) ? new Directory(ROOT(), id) : null;
}
async function keep(f: File, bytes: Uint8Array | string) {
  try {
    f.parentDirectory.create({ intermediates: true, idempotent: true });
    await f.write(bytes);
  } catch { /* only a cache */ }
}

let sodium: Sodium | undefined;

/** Decrypts records (only what is new or changed: known); the sodium instance is loaded before (loadLibrary). */
function decryptSome(raw: any[]): Item[] {
  const s = sodium!;
  const { masterKey: master, me } = session();
  if (!master || !me) throw new Error(t("Unlock your library first."));
  // photos from the background backup carry keys sealed to the account's key pair; it is opened only if needed
  let kp: KeyPair | undefined;
  const pair = () => (kp ??= accountKeyPair(s, unb64(s, me.wrapped_privkey), master, normEmail(me.user.email)));
  const hw = highWater(me.user.id);
  const out = raw.map((x) => decrypt(s, master, pair, x, hw)).sort(newest);
  hw.flush();
  if (kp) s.memzero(kp.sk);
  giveThumbKeys(out);
  return out;
}

async function decryptAll(raw: any[]): Promise<Item[]> {
  sodium = await getSodium();
  return decryptSome(raw);
}

const newest = (a: Item, b: Item) => when(b) - when(a);

/** The native thumbnails get the keys of what has one (it keeps only their thumbnail subkeys, until the next lock). */
function giveThumbKeys(items: Item[]) {
  const dir = userDir();
  N.thumbsSetup(server(), csrfToken(), dir?.uri ?? null);
  const withThumb = items.filter((it) => it.itemKey?.length === 32 && it.has_thumb && ID.test(it.id));
  const keys = new Uint8Array(withThumb.length * 32);
  withThumb.forEach((it, i) => keys.set(it.itemKey!, i * 32));
  N.thumbKeys(withThumb.map((it) => it.id), keys);
  keys.fill(0);
}

// ---- the lists, kept current with ?since (sync.ts): after the first whole list, a live update fetches and decrypts
// only what changed ----

// the server's records of the library as last loaded, by id: what list.json keeps, with the cursor they are current to
let records = new Map<string, any>();
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const library = new ListSync<Item>({
  path: "/api/items", get: (p) => api<Page>("GET", p), decrypt: decryptSome, order: newest,
  onPage: (raw, removed, full) => {
    if (full) records = new Map();
    for (const id of removed) records.delete(id);
    for (const x of raw) records.set(x.id, x);
    dirty ||= full || raw.length > 0 || removed.length > 0;
  },
});
const trash = new ListSync<Item>({
  path: "/api/trash", get: (p) => api<Page>("GET", p), decrypt: decryptSome,
  order: (a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0),
});

/** Drops both lists and their cursors (every lock and sign-out, and with the list on screen): the item keys they share
 *  with it are zeroed then. */
export function forgetLists() {
  library.forget(); trash.forget();
  records = new Map(); dirty = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

/** list.json: the records and the cursor they belong to, written together so the next start asks only for what
 *  changed after them. After a whole list at once; after changes at most every few seconds (a backup of hundreds of
 *  photos pings every second or two, and the file holds the whole library). */
function saveList(now: boolean) {
  if (!dirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const write = () => {
    saveTimer = null;
    const dir = userDir();
    if (!dir || !dirty) return;
    dirty = false;
    keep(new File(dir, "list.json"), JSON.stringify({ cursor: library.at, wholeAt: library.wholeAt, items: [...records.values()] })).catch(() => {});
  };
  if (now) write(); else saveTimer = setTimeout(write, 5000);
}

/** The trash, newest first; the server deletes each item permanently at its purge_at. */
export async function loadTrash(): Promise<{ items: Item[]; retentionDays: number }> {
  sodium = await getSodium();
  const r = await trash.load();
  return { items: r.items, retentionDays: (r.extra.retention_days as number) ?? 30 };
}

/** The whole library, newest capture first; after the first load only what changed. The same array comes back when
 *  nothing changed. */
export async function loadLibrary(): Promise<Item[]> {
  if (!session().masterKey) throw new Error(t("Unlock your library first."));
  sodium = await getSodium();
  const r = await library.load();
  saveList(r.full);
  return r.items;
}

/** The list as it was last loaded, shown at once while the current one loads; with its cursor, the load after it
 *  fetches only what changed since. */
export async function loadCachedLibrary(): Promise<Item[] | null> {
  const dir = userDir();
  const f = dir && new File(dir, "list.json");
  if (!f?.exists) return null;
  try {
    const kept = JSON.parse(await f.text());
    // before incremental lists the file held only the records
    const raw: any[] = Array.isArray(kept) ? kept : kept.items;
    const cursor = !Array.isArray(kept) && typeof kept.cursor === "string" ? kept.cursor : undefined;
    const wholeAt = !Array.isArray(kept) && typeof kept.wholeAt === "number" ? kept.wholeAt : 0;
    const items = await decryptAll(raw);
    if (!library.current) {
      records = new Map(raw.map((x) => [x.id, x]));
      library.seed(items, cursor, wholeAt);
    }
    return items;
  } catch { return null; }
}

/** The search index's copies in the same folder (search/engine.ts): the server's entries per model family
 *  (index-<family>.json) and the opened index (index-<family>.bin). Left alone here: the indexing phone still reads
 *  MobileCLIP's entries from before for their faces until it has made the new ones (search/engine.ts deletes them). */
const SEARCH_COPY = /^index-[a-z0-9][a-z0-9._-]{0,63}\.(json|bin)$/;

/** Drops cached images of items that are gone, and all but the newest previews. Only images: the list and the search
 *  index's copies stay (deleting those made every start fetch and open the whole index again). */
export function pruneCache(ids: Set<string>) {
  const dir = userDir();
  if (!dir?.exists) return;
  const previews: File[] = [];
  try {
    for (const f of dir.list()) {
      if (!(f instanceof File) || f.name === "list.json" || SEARCH_COPY.test(f.name)) continue;
      const m = /^(thumb|preview)-([0-9a-f]{32})$/.exec(f.name);
      if (!m || !ids.has(m[2])) f.delete();
      else if (m[1] === "preview") previews.push(f);
    }
    previews.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0)).slice(300).forEach((f) => f.delete());
  } catch { /* only a cache */ }
}

// ---- images ----

class Lru {
  private m = new Map<string, string>();
  constructor(private max: number) {}
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  clear() { this.m.clear(); }
  /** every entry of one item, whatever picture version */
  forget(id: string) { for (const k of [...this.m.keys()]) if (k === id || k.startsWith(id + ".")) this.m.delete(k); }
}

const previews = new Lru(12);

/** The thumbnail and preview of an item were made anew (an edit): the copies kept here go, on disk, in memory and in
 *  the native thumbnails, and the screens showing them load the new ones. */
export function forgetPictures(id: string) {
  previews.forget(id);
  const dir = userDir();
  if (dir && ID.test(id)) for (const kind of ["thumb", "preview"]) try { const f = new File(dir, `${kind}-${id}`); if (f.exists) f.delete(); } catch { /* only a cache */ }
  try { N.thumbsForget?.([id]); } catch { /* an older native module: its bitmaps go at the next lock */ }
}
const inflight = new Map<string, Promise<string>>();

// Downloads run a dozen at a time, newest request first; one nobody wants any more by its turn is skipped.
let active = 0;
const waiters: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>, wanted: () => boolean): Promise<T> {
  if (active >= 12) await new Promise<void>((r) => waiters.push(r));
  if (!wanted()) { waiters.pop()?.(); throw new Error("cancelled"); }
  active++;
  try { return await fn(); } finally { active--; waiters.pop()?.(); }
}

// thumbnails for search go out many to a request; one at a time against an older server (the grid's: Thumbs.kt)
const batcher = new ThumbBatcher((ids) => postForBytes("/api/items/thumbs", { item_ids: ids }), (id, wanted) => limited(() => getBytes(`/api/items/${id}/thumb`), wanted));

/** The decrypted JPEG of a thumbnail or preview (the caller zeroes it); the verified ciphertext is kept in the cache. */
async function plainBytes(kind: "thumb" | "preview", it: Item, wanted: () => boolean): Promise<Uint8Array> {
  const s = await getSodium();
  const open = (ct: Uint8Array) => {
    if (!session().masterKey) throw new Error(t("Unlock your library first."));
    return (kind === "thumb" ? decryptThumb : decryptPreview)(s, ct, it.itemKey!, it.id);
  };
  const dir = userDir();
  const f = dir && ID.test(it.id) ? new File(dir, `${kind}-${it.id}`) : null;
  if (f?.exists) {
    try { return open(await f.bytes()); } catch { if (session().masterKey) try { f.delete(); } catch { /* damaged copy, fetched again */ } }
  }
  const ct = kind === "thumb" ? await batcher.get(it.id, wanted) : await limited(() => getBytes(`/api/items/${it.id}/preview`), wanted);
  const plain = open(ct); // only verified ciphertext is kept
  if (f) await keep(f, ct);
  return plain;
}

/** For search: the best image the server has of an item, decrypted, without filling the display caches. */
export function imageBytes(it: Item): Promise<Uint8Array> {
  if (!it.itemKey) return Promise.reject(new Error("no key"));
  return plainBytes(it.has_preview ? "preview" : "thumb", it, () => true);
}
export const thumbBytes = (it: Item) => (it.itemKey && it.has_thumb ? plainBytes("thumb", it, () => true) : Promise.reject(new Error("no thumbnail")));

/** The viewer's sharp picture, as a data: URI; the newest dozen stay in memory. */
export function previewUri(it: Item): Promise<string> {
  const key = pictureKey(it.id, it.meta); // a new version after an edit
  const hit = previews.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const plain = await plainBytes("preview", it, () => true);
      const uri = "data:image/jpeg;base64," + N.base64(plain);
      plain.fill(0);
      if (!session().masterKey) throw new Error(t("Unlock your library first.")); // locked while this was loading
      previews.set(key, uri);
      return uri;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** The newest thumbnails not yet on this phone, fetched ahead after the library loads (natively, into the encrypted
 *  cache only; after what is on screen). */
export function prefetchThumbs(items: Item[]) {
  N.thumbsPrefetch(items.filter((it) => it.has_thumb && !it.broken && it.itemKey && ID.test(it.id)).slice(0, 400).map((it) => it.id));
}
export function clearImages() { previews.clear(); inflight.clear(); N.thumbsClearImages(); }

onWipe(() => { known = new Map(); forgetLists(); });

onWipe((how) => {
  clearImages();
  N.forgetThumbs?.(); // thumbnail keys and bitmaps
  N.forgetVideos?.(); // video keys and decrypted segments
  if (how === "ended") try { const r = ROOT(); if (r.exists) r.delete(); } catch { /* best effort */ }
  if (how === "ended") { versions = null; try { const v = VERSIONS(); if (v.exists) v.delete(); } catch { /* best effort */ } }
});
