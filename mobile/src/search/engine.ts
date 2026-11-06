// Search on the phone, while the library is unlocked: keeps the decrypted index in native memory (SearchIndex.kt),
// fetches entries other devices or the background made, and indexes what has none yet. Each entry is computed from the
// item's decrypted preview (or thumbnail), sealed to the account's public key and stored on the server, so it is
// computed once per photo, not once per device. A lock forgets all of it from memory.
//
// So that search works seconds after unlocking, not only after every entry was opened again, the phone also keeps a
// copy of the opened index, encrypted (XChaCha20-Poly1305) under a key derived from the master key: it opens only
// after an unlock, is bound to the account and model, and goes with the rest of the account's cache at sign-out or
// when another account signs in (library.ts). At unlock that copy is loaded first, with only the text model; then
// only entries that changed since are opened, and the image models load only when there is something to index.
import { useSyncExternalStore } from "react";
import { Directory, File, Paths } from "expo-file-system";
import { getSodium, b64, unb64, type Sodium } from "@crypto/sodium";
import { accountKeyPair, type KeyPair } from "@crypto/item";
import { normEmail } from "@crypto/account";
import { decryptPeople, openIndexEntry, sealIndexEntry, type IndexEntry } from "@crypto/search";
import N, { type Analysis, type Hit } from "../../modules/cf-native/src/CfNativeModule";
import { api, ApiError, server } from "../api";
import { onWipe, refreshMe, session, type Me } from "../session";
import { imageBytes, type Item } from "../library";
import { fingerprint } from "../prints";
import { downloadModels, downloadSize, dropOtherModels, family, haveModels, modelPath, modelTag, tokenizerFile, type Clip } from "./models";
import { loadSettings, saveSettings, settingsDir, type SearchSettings } from "./settings";
import { keepRunning, letGo, onlyHolder } from "../keepAlive";
import { Tokenizer } from "./tokenizer";
import { explicitSearchOffered } from "../store";

export type Phase = "off" | "waitWifi" | "download" | "loading" | "indexing" | "ready" | "error";
export interface Progress { phase: Phase; done: number; total: number; message?: string }

let progress: Progress = { phase: "off", done: 0, total: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<Progress>) => { progress = { ...progress, ...p }; subs.forEach((f) => f()); };
export const useSearchProgress = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => progress);
export const searchProgress = () => progress;

/** Which model made each item's entry: those from another model (or without faces, when faces are on) are redone. */
const tags = new Map<string, string>();
/** Which of the server's entries each item's index is from (a stamp of its ciphertext): a changed one is opened again. */
const seen = new Map<string, string>();
const stamp = (enc: string) => enc.slice(-24);
let wipes = 0; // counts locks: a copy still loading when the library locks is dropped
let pair: KeyPair | null = null;
let run: { cancelled: boolean } | null = null;
let ready = false;
let changed = 0; // counts index changes, for screens that show people
export const indexVersion = () => changed;

export const searchReady = () => ready;

/** Whether this phone computes the index (docs/SEARCH.md "One device indexes"): when no device does yet, or this one. */
export const indexesHere = (me: Me | null) => !me?.indexer || !me.session_id || me.indexer === me.session_id;
let indexes = true;
export const thisPhoneIndexes = () => indexes;
// the model in use: MobileCLIP, or LAION for explicit search (docs/SEARCH.md); entries of the other one are made again
let clip: Clip = "mobileclip-s2";
export const activeClip = () => clip;
const good = (tag: string | undefined, faces: boolean) => tag === modelTag(clip, true) || (!faces && tag === modelTag(clip, false));

/** The account's model: LAION only if an admin allowed explicit search and the person chose it (in the people document,
 *  so all their devices use one index); MobileCLIP otherwise. */
export async function accountClip(): Promise<Clip> {
  const { me, masterKey } = session();
  // the Play build never uses it (src/store.ts): it searches with MobileCLIP whatever the account chose
  if (!me?.user.nsfw || !explicitSearchOffered() || !masterKey) return "mobileclip-s2";
  const s = await getSodium();
  try {
    const r = await api<{ data_enc: string }>("GET", "/api/me/blobs/people");
    return decryptPeople<{ explicit?: boolean }>(s, unb64(s, r.data_enc), masterKey, me.user.id).explicit ? "laion-b32" : "mobileclip-s2";
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return "mobileclip-s2";
    throw e;
  }
}

// ---- the server's entries, kept encrypted in the cache folder so a start needs only what changed ----

// one per model family: the server keeps both models' entries apart, and so does this copy
const cacheFile = () => {
  const id = session().me?.user.id;
  return id && /^[0-9A-Za-z_-]{1,64}$/.test(id) ? new File(new Directory(Paths.cache, "cf-ct"), id, `index-${family(clip)}.json`) : null;
};
interface Cache { since: number; entries: Record<string, string> }
async function readCache(): Promise<Cache> {
  const f = cacheFile();
  try {
    // only a cache: anything else in the file (cut short, "null", an older shape) starts over
    const c = f?.exists ? JSON.parse(await f.text()) : null;
    if (c && typeof c.since === "number" && c.entries && typeof c.entries === "object" && !Array.isArray(c.entries)) return c;
  } catch { /* start over */ }
  return { since: 0, entries: {} };
}
async function writeCache(c: Cache) {
  const f = cacheFile();
  if (!f) return;
  try { f.parentDirectory.create({ intermediates: true, idempotent: true }); await f.write(JSON.stringify(c)); } catch { /* only a cache */ }
}

function put(s: Sodium, id: string, e: IndexEntry, faces: boolean, enc: string) {
  const fs = faces ? e.faces ?? [] : [];
  const embs = new Uint8Array(fs.length * 256);
  fs.forEach((f, i) => embs.set(unb64(s, f.emb).subarray(0, 256), i * 256));
  tags.set(id, e.m);
  seen.set(id, stamp(enc));
  return N.indexPut(id, e.clip ? unb64(s, e.clip) : null, fs.map((f) => f.box), fs.map((f) => f.score), embs);
}

// ---- the opened index, kept encrypted on the phone between unlocks ----

/** A crypto_kdf context of its own (8 characters), different from every one in @crypto/kdf. */
const COPY_CTX = "IDXCOPY1";
const nativePath = (f: File) => f.uri.replace(/^file:\/\//, "");
/** Where the copy is, its key (derived from the master key; the caller passes it on and it is wiped) and what it is
 *  bound to: this account and this model family. */
async function copyPlace(master: Uint8Array) {
  const id = session().me?.user.id;
  if (!id || !/^[0-9A-Za-z_-]{1,64}$/.test(id)) return null;
  const s = await getSodium();
  return {
    path: nativePath(new File(new Directory(Paths.cache, "cf-ct"), id, `index-${family(clip)}.bin`)),
    key: s.crypto_kdf_derive_from_key(32, 1, COPY_CTX, master),
    ad: s.from_string(`cipherfilm search index copy v1|${id}|${family(clip)}`),
  };
}

let saving: Promise<void> = Promise.resolve();
/** Writes the copy (natively: the opened index never passes through here). Only while still unlocked with master. */
function saveCopy(master: Uint8Array): Promise<void> {
  saving = saving.catch(() => {}).then(async () => {
    if (session().masterKey !== master || !ready) return;
    const at = await copyPlace(master);
    if (!at) return;
    const items: Record<string, [string, string]> = {};
    for (const [id, tag] of tags) items[id] = [tag, seen.get(id) ?? ""];
    try { await N.indexSave(at.path, at.key, at.ad, JSON.stringify({ v: 1, items })); } catch { /* only a cache */ } finally { at.key.fill(0); }
  });
  return saving.catch(() => {});
}

/** Loads the copy into the index, with the list of what each item has; false when there is none that opens. */
async function loadCopy(master: Uint8Array, faces: boolean): Promise<boolean> {
  const at = await copyPlace(master);
  if (!at) return false;
  const gen = wipes;
  let extra: string | null = null;
  try { extra = await N.indexLoad(at.path, at.key, at.ad, faces); } catch { /* made again from the server's entries */ } finally { at.key.fill(0); }
  if (gen !== wipes || session().masterKey !== master) { if (extra !== null) N.indexClear(); return false; } // locked meanwhile
  if (extra === null) return false;
  try {
    const c = JSON.parse(extra) as { v: number; items: Record<string, [string, string]> };
    tags.clear(); seen.clear();
    for (const [id, [tag, st]] of Object.entries(c.items)) { tags.set(id, tag); seen.set(id, st); }
    return true;
  } catch {
    N.indexClear(); tags.clear(); seen.clear();
    return false;
  }
}

/** Opens the text model (searching) or everything (indexing too), unless it is open already. */
async function openVision(st: SearchSettings, all: boolean) {
  const v = N.visionState();
  const same = v.clip === clip && v.dir === modelPath().replace(/\/+$/, "");
  if (same && (all ? v.image && v.text && v.faces === st.faces : v.text)) return;
  // a phone that indexes opens everything at once; text only closes the image side, so only when it isn't open
  await N.visionOpen(modelPath(), st.faces, clip, all || (same && v.image));
}

let syncing = false;
let warming: Promise<void> | null = null;
/**
 * Right after unlocking: search from the copy on the phone, before the library or anything from the server arrived.
 * startSearch then opens only the entries that changed since. Does nothing when search is off or already ready.
 */
export function warmSearch(): Promise<void> {
  warming ??= (async () => {
    const st = await loadSettings();
    const master = session().masterKey;
    if (!st.enabled || !master || ready || syncing) return;
    const want = st.clip ?? clip;
    if (want !== clip) { N.indexClear(); tags.clear(); seen.clear(); changed++; clip = want; }
    set({ phase: "loading", done: 0, total: 0, message: undefined });
    const text = (async () => { if (await haveModels(st.faces, clip, false)) await openVision(st, false); })().catch(() => {});
    const got = await loadCopy(master, st.faces);
    if (got && !ready && session().masterKey === master) {
      ready = true; changed++;
      set({ phase: "ready", done: tags.size, total: tags.size, message: undefined });
    }
    await text;
  })().catch(() => {}).finally(() => { warming = null; });
  return warming;
}

const pause = () => new Promise((r) => setTimeout(r, 0));

// While it downloads the models, the app keeps running when it leaves the screen: the foreground service (a data
// transfer, as for uploads, keepAlive.ts) and its notification. Indexing is not a transfer and never runs in that
// service: it goes on while the app is open (and when Android lets the process run), and the background task
// (background.ts, WorkManager without a foreground service) does what is on the phone.
let held = false;
let shownAt = 0;
function hold(title: string, text: string) {
  if (held) return;
  held = true;
  keepRunning("search", title, text);
}
function show(title: string, text: string, done: number, total: number) {
  const now = Date.now();
  if (!held || !onlyHolder("search") || (now - shownAt < 1000 && done < total)) return; // the backup's progress wins
  shownAt = now;
  N.backupNotify(title, text, total ? done / total : -1, true);
}
function release() {
  if (!held) return;
  held = false;
  letGo("search");
}
const mbs = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Starts (or restarts) search for the unlocked library: models, the server's entries, then what is missing. */
export async function startSearch(library: Item[]) {
  const st = await loadSettings();
  run && (run.cancelled = true);
  if (!st.enabled) { set({ phase: "off", done: 0, total: 0, message: undefined }); return; }
  const me = session().me, master = session().masterKey;
  if (!me || !master) return;
  const mine = { cancelled: false };
  run = mine;
  const live = () => !mine.cancelled && session().masterKey === master;
  try {
    await warmSearch(); // the copy on the phone first: search works while the rest catches up
    if (!live()) return;
    syncing = true;
    const s = await getSodium();
    // the account as it is now: an admin may have allowed explicit search, another device may index since
    const now = await refreshMe().catch(() => me) ?? me;
    const want = await accountClip();
    if (!live()) return;
    indexes = indexesHere(now);
    // the other model's vectors don't compare, and its files go at once (not only when the new one downloads)
    if (want !== clip) { N.indexClear(); N.visionClose(); tags.clear(); seen.clear(); ready = false; changed++; clip = want; }
    dropOtherModels(clip, indexes);
    // for the background, which can't read the people document or ask the server
    if (st.clip !== want || st.indexes !== indexes) await saveSettings({ clip: want, indexes });
    if (!(await haveModels(st.faces, clip, indexes))) {
      if (st.wifiOnly && !N.backupState().unmetered) { set({ phase: "waitWifi", done: 0, total: downloadSize(st.faces, clip, indexes), message: undefined }); return; }
      set({ phase: "download", done: 0, total: 1, message: undefined });
      hold("Downloading the search model", "");
      await downloadModels(server(), st.faces, clip, (done, total) => {
        if (!live()) return;
        set({ phase: "download", done, total });
        show("Downloading the search model", `${mbs(done)} of ${mbs(total)}`, done, total);
      }, indexes);
      release(); // the download is done: indexing doesn't keep the service (above)
      if (!live()) return;
    }
    if (!ready) set({ phase: "loading", done: 0, total: 0 });
    await openVision(st, false); // the image models only once there is something to index (below)
    pair ??= accountKeyPair(s, unb64(s, me.wrapped_privkey), master, normEmail(me.user.email));
    if (!live()) return;

    // what the server has: everything new since the last visit, added to the encrypted copy here
    const cache = await readCache();
    let after = "";
    for (;;) {
      const q = (after ? `after=${encodeURIComponent(after)}` : `since=${cache.since}`) + `&model=${family(clip)}`;
      const page = await api<{ entries: { item_id: string; data_enc: string; updated_at: number }[]; next: string; now: number }>("GET", `/api/index?${q}`);
      for (const e of page.entries) { cache.entries[e.item_id] = e.data_enc; cache.since = Math.max(cache.since, e.updated_at); }
      if (!page.next) break;
      after = page.next;
    }
    await writeCache(cache);
    const ids = new Set(library.map((i) => i.id));
    // only what isn't in the index yet, or changed since (the copy from the last unlock has the rest)
    const open = Object.entries(cache.entries).filter(([id, enc]) => ids.has(id) && !(seen.get(id) === stamp(enc) && good(tags.get(id), st.faces)));
    let n = 0, touched = false;
    for (const [id, enc] of open) {
      if (!live()) return;
      try { await put(s, id, openIndexEntry(s, unb64(s, enc), pair!, id), st.faces, enc); touched = true; } catch { delete cache.entries[id]; /* damaged or not for this item: made again */ }
      if (++n % 200 === 0) { await pause(); if (!ready) set({ phase: "loading", done: n, total: open.length }); }
    }
    for (const id of [...tags.keys()]) if (!ids.has(id)) { tags.delete(id); seen.delete(id); N.indexRemove(id); touched = true; }
    ready = true; changed++;
    if (touched) await saveCopy(master);
    await rememberForBackground(library, st);

    // what has no entry yet: newest first; only on the phone that indexes (the others take what it stores)
    if (!indexes) { set({ phase: "ready", done: tags.size, total: ids.size, message: undefined }); return; }
    const todo = library.filter((i) => !i.broken && i.itemKey && i.kind !== "other" && (i.has_preview || i.has_thumb) && !good(tags.get(i.id), st.faces));
    const total = ids.size;
    let done = total - todo.length;
    set({ phase: todo.length ? "indexing" : "ready", done, total, message: undefined });
    if (todo.length) await openVision(st, true);
    const pk = unb64(s, me.pubkey);
    if (!s.memcmp(pk, pair!.pk)) throw new Error("Your account's keys don't match.");
    let since = 0, notIndexer = false;
    const work = async () => {
      while (todo.length && live()) {
        const it = todo.shift()!;
        try {
          const entry = await analyzeItem(it, st.faces);
          if (!live()) return;
          const enc = b64(s, sealIndexEntry(s, entry, pk, it.id));
          await api("PUT", `/api/items/${it.id}/index`, { data_enc: enc, model: entry.m }); // the tag, see docs/SEARCH.md
          if (!live()) return; // locked or signed out while it was sent: the index was emptied and stays so
          cache.entries[it.id] = enc;
          await put(s, it.id, entry, st.faces, enc);
          changed++;
        } catch (e) {
          if ((e as { status?: number }).status === 0) throw e; // offline: stop, try again later
          if (e instanceof ApiError && e.code === "not_indexer") { notIndexer = true; todo.length = 0; return; }
        }
        done++;
        if (++since % 10 === 0) set({ done });
        if (since % 50 === 0) { await writeCache(cache); await rememberForBackground(library, st); }
        if (since % 200 === 0) await saveCopy(master);
      }
    };
    await Promise.all([work(), work()]);
    await writeCache(cache);
    if (since) await saveCopy(master);
    await rememberForBackground(library, st);
    if (notIndexer) { // another device became the indexer meanwhile: this phone only searches from now on
      indexes = false; await saveSettings({ indexes: false }); dropOtherModels(clip, false); N.visionOpen(modelPath(), st.faces, clip, false).catch(() => {});
      if (live()) set({ phase: "ready", done: tags.size, total });
      return;
    }
    if (live()) set({ phase: "ready", done, total });
  } catch (e) {
    if (live()) set({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (run === mine) { release(); syncing = false; } // a newer run took over: it holds (or lets go) itself
  }
}

export const stopSearch = () => { if (run) run.cancelled = true; release(); };

/** "Index on this phone instead": this phone becomes the account's indexing device and loads the image models. */
export async function indexHere(library: Item[]) {
  await api("PUT", "/api/me/indexer");
  await refreshMe().catch(() => null);
  await startSearch(library);
}

async function analyzeItem(it: Item, faces: boolean) { return analyzeBytes(await imageBytes(it), faces, clip); }

/** The entry for one picture (the bytes are wiped). One with nothing to see in it (not an image, or a sliver) gets an
 *  empty entry, stored like any other: it never matches a search, and isn't tried again at every start. */
export async function analyzeBytes(bytes: Uint8Array, faces: boolean, model: Clip): Promise<IndexEntry> {
  let a: Analysis;
  try {
    a = await N.visionAnalyze(bytes, faces);
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "ERR_UNUSABLE_IMAGE") return { v: 1, m: modelTag(model, faces), ...(faces ? { faces: [] } : {}) };
    throw e;
  } finally {
    bytes.fill(0);
  }
  return toEntry(await getSodium(), a, faces, model);
}

export function toEntry(s: Sodium, a: Analysis, faces: boolean, model: Clip): IndexEntry {
  return {
    v: 1, m: modelTag(model, faces), clip: b64(s, a.clip),
    ...(faces ? { faces: (a.faces ?? []).map((f) => ({ box: f.box, score: f.score, emb: b64(s, f.emb) })) } : {}),
  };
}

// ---- for the background (search/background.ts): which phone photos are in the library, and which are done ----

export const localFile = () => new File(settingsDir(), "local.json");
async function rememberForBackground(library: Item[], st: SearchSettings) {
  if (!st.background) return;
  const prints: Record<string, string> = {};
  for (const it of library) if (it.meta && !it.broken) prints[await fingerprint(it.meta.name, it.meta.size)] = it.id;
  const done = library.filter((i) => good(tags.get(i.id), st.faces)).map((i) => i.id);
  try { settingsDir().create({ intermediates: true, idempotent: true }); await localFile().write(JSON.stringify({ userId: session().me?.user.id, prints, done })); } catch { /* next time */ }
}

// ---- queries ----

let tokenizer: Tokenizer | null = null;

/** Every indexed item, best match for the words first: ranked like Immich's smart search, with no cut-off (the list
 *  shows page by page as it scrolls; filters narrow it in search/query.ts). */
export async function textSearch(q: string, limit = 100_000): Promise<Hit[]> {
  if (!ready) return [];
  await openVision(await loadSettings(), false); // (the background closes the models when it ran while the app was away)
  tokenizer ??= new Tokenizer(JSON.parse(await tokenizerFile().text()));
  const vec = await N.visionText(tokenizer.encode(q));
  return N.indexSearch(vec, limit, -1);
}

export const similarTo = (id: string) => (ready ? N.indexSimilar(id, 60, 0.6) : Promise.resolve([]));

/** Turns search off on this phone; with clear also the index on the server (entries of every device). */
export async function forgetSearch(clear: boolean) {
  stopSearch();
  try { await api("DELETE", "/api/me/indexer"); } catch { /* the next device that indexes takes over anyway once this one signs out */ }
  N.indexClear(); tags.clear(); seen.clear(); ready = false; changed++;
  try { const d = new Directory(Paths.cache, "cf-ct"); if (d.exists) d.delete(); } catch { /* best effort */ }
  try { if (localFile().exists) localFile().delete(); } catch { /* best effort */ }
  if (clear) await api("DELETE", "/api/index");
  set({ phase: "off", done: 0, total: 0, message: undefined });
}

onWipe(() => {
  stopSearch();
  wipes++;
  N.indexClear?.();
  tags.clear(); seen.clear();
  if (pair) { pair.sk.fill(0); pair = null; }
  ready = false; changed++;
  set({ phase: "off", done: 0, total: 0, message: undefined });
});
