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
import { api, ApiError } from "../api";
import { onWipe, refreshMe, session, type Me } from "../session";
import { imageBytes, type Item } from "../library";
import { fingerprint } from "../prints";
import { CLIP, downloadModels, downloadSize, dropOtherModels, family, haveModels, LEGACY_FAMILY, legacyFaces, modelPath, modelTag, NeedsConsent, tokenizerFile, toCompute, unagreed, type Clip } from "./models";
import { conceptData, IMAGE_THRESHOLD, queryBlocked, unfiltered } from "@websearch/explicit";
import { loadSettings, saveSettings, settingsDir, type SearchSettings } from "./settings";
import { keepRunning, letGo, onlyHolder } from "../keepAlive";
import { Tokenizer } from "./tokenizer";
import { explicitSearchOffered } from "../store";
import { t } from "../i18n";

/** consent: the models (or some of them) aren't here and the person hasn't agreed to download them yet (models.ts);
 *  total is the download's size. Nothing is fetched until they do. */
export type Phase = "off" | "consent" | "waitWifi" | "download" | "loading" | "indexing" | "ready" | "error";
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
const forgetTags = () => { tags.clear(); seen.clear(); };
let wipes = 0; // counts locks: a copy still loading when the library locks is dropped
let pair: KeyPair | null = null;
let run: { cancelled: boolean } | null = null;
/** The run still going (run stays set after it ended), and a newer library that came while it went (see libraryChanged). */
let active: { cancelled: boolean } | null = null;
let queued: Item[] | null = null;
let ready = false;
let changed = 0; // counts index changes, for screens that show people
export const indexVersion = () => changed;

export const searchReady = () => ready;

/** Whether this phone computes the index (docs/SEARCH.md "One device indexes"): when no device does yet, or this one. */
export const indexesHere = (me: Me | null) => !me?.indexer || !me.session_id || me.indexer === me.session_id;
let indexes = true;
export const thisPhoneIndexes = () => indexes;
// the model: one for everyone (docs/SEARCH.md "One model"); entries an older app made with MobileCLIP are made again
const clip: Clip = CLIP;
export const activeClip = () => clip;
const good = (tag: string | undefined, faces: boolean) => tag === modelTag(clip, true) || (!faces && tag === modelTag(clip, false));
/** What this phone still computes for an item: nothing on a phone that only searches. */
const missing = (id: string, faces: boolean) => (indexes ? toCompute(tags.get(id), faces, clip) : []);

/** Whether search leaves out explicit photos and words (docs/SEARCH.md "Explicit content"): yes until the account is
 *  known, and always in the Play build. */
let filtered = true;
export const searchFiltered = () => filtered;

/** Whether this account's search is filtered: unless an admin allowed explicit search, the person chose it (in the
 *  people document, for all their devices) and this build offers it (never the Play build, src/store.ts). */
export async function accountFiltered(): Promise<boolean> {
  const { me, masterKey } = session();
  if (!me?.user.nsfw || !explicitSearchOffered() || !masterKey) return true;
  const s = await getSodium();
  try {
    const r = await api<{ data_enc: string }>("GET", "/api/me/blobs/people");
    const chosen = decryptPeople<{ explicit?: boolean }>(s, unb64(s, r.data_enc), masterKey, me.user.id).explicit === true;
    return !unfiltered({ allowed: true, chosen, offered: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return true;
    throw e;
  }
}

/** The filter's concepts go to the native index once per start (they belong to the app; a lock keeps them). */
let concepts: Promise<void> | null = null;
const giveConcepts = () => {
  concepts ??= (async () => { const c = conceptData(); await N.indexConcepts(c.vecs, c.explicit, c.image, IMAGE_THRESHOLD); })()
    .catch((e) => { concepts = null; throw e; });
  return concepts;
};

// ---- the server's entries, kept encrypted in the cache folder so a start needs only what changed ----

// one per model family: the server keeps them apart (MobileCLIP's, left from before, are read for their faces only)
const cacheFile = (fam: string) => {
  const id = session().me?.user.id;
  return id && /^[0-9A-Za-z_-]{1,64}$/.test(id) ? new File(new Directory(Paths.cache, "cf-ct"), id, `index-${fam}.json`) : null;
};
interface Cache { since: number; entries: Record<string, string> }
async function readCache(fam = family(clip)): Promise<Cache> {
  const f = cacheFile(fam);
  try {
    // only a cache: anything else in the file (cut short, "null", an older shape) starts over
    const c = f?.exists ? JSON.parse(await f.text()) : null;
    if (c && typeof c.since === "number" && c.entries && typeof c.entries === "object" && !Array.isArray(c.entries)) return c;
  } catch { /* start over */ }
  return { since: 0, entries: {} };
}
async function writeCache(c: Cache, fam = family(clip)) {
  const f = cacheFile(fam);
  if (!f) return;
  try { f.parentDirectory.create({ intermediates: true, idempotent: true }); await f.write(JSON.stringify(c)); } catch { /* only a cache */ }
}

/** Adds what the server has for a family since the cache's last visit. When it has fewer entries than the cache, some
 *  were deleted there (MobileCLIP's go as the new ones are made): the cache starts over. True when the cache now holds all of the server's entries and nothing else (it started from none).
 *  A server that doesn't count yet is taken at its word. */
async function fetchEntries(cache: Cache, fam: string): Promise<boolean> {
  if (cache.since === 0) cache.entries = {}; // from none: the server sends them all, and nothing stays that it lost
  for (let again = cache.since === 0; ; again = true) {
    let after = "", count: number | undefined;
    for (;;) {
      const q = (after ? `after=${encodeURIComponent(after)}` : `since=${cache.since}`) + `&model=${fam}`;
      const page = await api<{ entries: { item_id: string; data_enc: string; updated_at: number }[]; next: string; now: number; count?: number }>("GET", `/api/index?${q}`);
      if (!after) count = page.count;
      for (const e of page.entries) { cache.entries[e.item_id] = e.data_enc; cache.since = Math.max(cache.since, e.updated_at); }
      if (!page.next) break;
      after = page.next;
    }
    if (again || count === undefined || Object.keys(cache.entries).length <= count) return again;
    cache.since = 0; cache.entries = {};
  }
}

function put(s: Sodium, id: string, e: IndexEntry, faces: boolean, enc: string) {
  const fs = faces ? e.faces ?? [] : [];
  const embs = new Uint8Array(fs.length * 256);
  fs.forEach((f, i) => embs.set(unb64(s, f.emb).subarray(0, 256), i * 256));
  tags.set(id, e.m);
  seen.set(id, stamp(enc));
  // a vector of another model (MobileCLIP's, from an older app) doesn't compare with this one's: kept out until made again
  const vec = e.clip && family(clip) === e.m.split(/[+/]/)[0] ? unb64(s, e.clip) : null;
  return N.indexPut(id, vec, fs.map((f) => f.box), fs.map((f) => f.score), embs);
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
    forgetTags();
    for (const [id, [tag, st]] of Object.entries(c.items)) { tags.set(id, tag); seen.set(id, st); }
    return true;
  } catch {
    N.indexClear(); forgetTags();
    return false;
  }
}

/** Opens the text model (searching) or everything (indexing too), unless it is open already. One after the other: what
 *  is open is read once the one before is done, so a search asking for the text model while the image models are
 *  still opening (they open next to fetching the entries, startSearch) doesn't close them again. */
let visionQueue: Promise<unknown> = Promise.resolve();
function openVision(st: SearchSettings, all: boolean): Promise<void> {
  const next = visionQueue.catch(() => {}).then(() => openNow(st, all));
  visionQueue = next;
  return next;
}
async function openNow(st: SearchSettings, all: boolean) {
  const v = N.visionState();
  const same = v.clip === clip && v.dir === modelPath().replace(/\/+$/, "");
  if (same && (all ? v.image && v.text && v.faces === st.faces : v.text)) return;
  // a phone that indexes opens everything at once; text only closes the image side, so only when it isn't open
  const image = all || (same && v.image);
  await N.visionOpen(modelPath(), st.faces, clip, image);
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
    set({ phase: "loading", done: 0, total: 0, message: undefined });
    await giveConcepts().catch(() => {}); // before any vector comes in: each is scored as it does
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

/** Back to the event loop (a timer, not a microtask): touches, rendering and other screens' requests go first. The
 *  indexer does this between photos and every few dozen entries, so it never holds the JS thread for long. */
const pause = () => new Promise((r) => setTimeout(r, 0));
const BATCH = 50;

// While it downloads the models, the app keeps running when it leaves the screen: the foreground service (a data
// transfer, as for uploads, keepAlive.ts) and its notification. Indexing is not a transfer and never runs in that
// service: it goes on while the app is open (and when Android lets the process run), and the background task
// (background.ts, WorkManager without a foreground service) does what is on the phone. A lock doesn't end a download
// (it needs no key): the service is held until it is done, and the next unlock joins it (models.ts).
let held = false;
let downloading = false;
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
  queued = null; // this run has the newest list
  if (!st.enabled) { set({ phase: "off", done: 0, total: 0, message: undefined }); return; }
  const me = session().me, master = session().masterKey;
  if (!me || !master) return;
  const mine = { cancelled: false };
  run = mine;
  active = mine;
  const live = () => !mine.cancelled && session().masterKey === master;
  let failed = false;
  try {
    await warmSearch(); // the copy on the phone first: search works while the rest catches up
    if (!live()) return;
    syncing = true;
    const s = await getSodium();
    // the account as it is now: an admin may have allowed explicit search, another device may index since
    const now = await refreshMe().catch(() => me) ?? me;
    const f = await accountFiltered();
    if (!live()) return;
    if (f !== filtered) { filtered = f; changed++; }
    indexes = indexesHere(now);
    await giveConcepts();
    dropOtherModels(clip, indexes);
    dropOldCopies();
    // for the background, which can't ask the server
    if (st.indexes !== indexes) await saveSettings({ indexes });
    if (!(await haveModels(st.faces, clip, indexes))) {
      // asked first (a model update, explicit search, faces or indexing here need new files): nothing goes out before
      if (unagreed(st.faces, clip, indexes).length) { set({ phase: "consent", done: 0, total: downloadSize(st.faces, clip, indexes), message: undefined }); return; }
      if (st.wifiOnly && !N.backupState().unmetered) { set({ phase: "waitWifi", done: 0, total: downloadSize(st.faces, clip, indexes), message: undefined }); return; }
      set({ phase: "download", done: 0, total: 1, message: undefined });
      hold(t("Downloading the search model"), "");
      downloading = true;
      try {
        await downloadModels(st.faces, clip, (done, total) => {
          show(t("Downloading the search model"), t("{done} of {total}", { done: mbs(done), total: mbs(total) }), done, total);
          if (live()) set({ phase: "download", done, total });
        }, indexes);
      } finally {
        downloading = false;
        release(); // the download is done: indexing doesn't keep the service (above)
      }
      if (!live()) return;
    }
    if (!ready) set({ phase: "loading", done: 0, total: 0, message: t("Opening the search models") });
    // The image models only when there is something to index: the phone that indexes opens them now, next to fetching
    // the server's entries (they open on their own thread, Lanes.kt), when the library has photos without an entry
    // here, as every one has on a new account right after the download. Otherwise only the text model, and the image
    // models below if the server's entries leave something to do.
    const eligible = (i: Item) => !i.broken && !!i.itemKey && i.kind !== "other" && (i.has_preview || i.has_thumb);
    const opening = openVision(st, indexes && library.some((i) => eligible(i) && missing(i.id, st.faces).length > 0));
    opening.catch(() => {}); // (awaited below)
    pair ??= accountKeyPair(s, unb64(s, me.wrapped_privkey), master, normEmail(me.user.email));
    if (!live()) return;
    if (!ready) set({ phase: "loading", done: 0, total: 0, message: t("Getting the index from the server") });

    // what the server has: everything new since the last visit, added to the encrypted copy here
    const cache = await readCache();
    const anew = await fetchEntries(cache, family(clip));
    await writeCache(cache);
    const ids = new Set(library.map((i) => i.id));
    let n = 0, touched = false;
    // entries deleted on the server meanwhile: out of the index, and made again by the phone that indexes
    if (anew) for (const id of [...tags.keys()]) if (!cache.entries[id]) { tags.delete(id); seen.delete(id); N.indexRemove(id); touched = true; }
    // only what isn't in the index yet, or changed since (the copy from the last unlock has the rest)
    const open = Object.entries(cache.entries).filter(([id, enc]) => ids.has(id) && !(seen.get(id) === stamp(enc) && good(tags.get(id), st.faces)));
    for (const [id, enc] of open) {
      if (!live()) return;
      try { await put(s, id, openIndexEntry(s, unb64(s, enc), pair!, id), st.faces, enc); touched = true; } catch { delete cache.entries[id]; /* damaged or not for this item: made again */ }
      if (++n % BATCH === 0) { await pause(); if (!ready) set({ phase: "loading", done: n, total: open.length, message: undefined }); }
    }
    for (const id of [...tags.keys()]) if (!ids.has(id)) { tags.delete(id); seen.delete(id); N.indexRemove(id); touched = true; }
    ready = true; changed++;
    if (!live()) return;
    if (touched) await saveCopy(master);
    await opening;
    if (!live()) return;
    // for the background; not waited for: indexing starts at once (one write at a time, the newest list last)
    let lib = library;
    let remembering = Promise.resolve();
    const remember = () => (remembering = remembering.then(() => rememberForBackground(lib, st, live)).catch(() => {}));
    remember();

    // what has no entry yet: newest first; only on the phone that indexes (the others take what it stores)
    if (!indexes) { await remembering; set({ phase: "ready", done: tags.size, total: ids.size, message: undefined }); return; }
    const todo = library.filter((i) => eligible(i) && missing(i.id, st.faces).length);
    // MobileCLIP's entries left from before (docs/SEARCH.md "One model"): their faces go into the new entries, so no
    // face is looked for twice and the people document's names stay with them; only while something is missing
    const legacy = todo.length ? await fetchLegacy() : null;
    if (!live()) return;
    let total = ids.size;
    let done = total - todo.length;
    set({ phase: todo.length ? "indexing" : "ready", done, total, message: undefined });
    if (todo.length) await openVision(st, true);
    let since = 0, notIndexer = false, again = false;
    /** A newer library that came while indexing (libraryChanged): its new photos go first, the rest at the next run. */
    const absorb = () => {
      const next = queued;
      if (!next) return;
      queued = null; again = true; lib = next;
      const fresh = next.filter((i) => !ids.has(i.id));
      for (const i of fresh) ids.add(i.id);
      const add = fresh.filter((i) => eligible(i) && missing(i.id, st.faces).length);
      todo.unshift(...add);
      total += fresh.length; done += fresh.length - add.length;
      set({ total, done });
    };
    const pk = unb64(s, me.pubkey);
    if (!s.memcmp(pk, pair!.pk)) throw new Error(t("Your account's keys don't match."));
    const work = async () => {
      while (todo.length && live()) {
        await pause(); // between photos: the app stays responsive (see pause)
        absorb();
        if (!todo.length || !live()) return;
        const it = todo.shift()!;
        try {
          const want = missing(it.id, st.faces);
          const entries = await analyzeItem(s, it, st.faces, want, legacy);
          for (const entry of entries) {
            if (!live()) return;
            const enc = b64(s, sealIndexEntry(s, entry, pk, it.id));
            await api("PUT", `/api/items/${it.id}/index`, { data_enc: enc, model: entry.m }); // the tag, see docs/SEARCH.md
            if (!live()) return; // locked or signed out while it was sent: the index was emptied and stays so
            cache.entries[it.id] = enc;
            if (legacy) delete legacy.entries[it.id]; // the server replaced it
            await put(s, it.id, entry, st.faces, enc);
            changed++;
          }
        } catch (e) {
          if ((e as { status?: number }).status === 0) throw e; // offline: stop, try again later
          if (e instanceof ApiError && e.code === "not_indexer") { notIndexer = true; todo.length = 0; return; }
        }
        done++;
        if (++since % 10 === 0) set({ done });
        if (since % 50 === 0) { await writeCache(cache); if (legacy) await writeCache(legacy, LEGACY_FAMILY); remember(); }
        if (since % 200 === 0) await saveCopy(master);
      }
    };
    await Promise.all([work(), work()]);
    await writeCache(cache);
    if (since) await saveCopy(master);
    // everything has the new model's entry: what is left of MobileCLIP's goes (photos it can't index, or no longer
    // there), on the server and here
    if (legacy && live() && !notIndexer && !library.some((i) => eligible(i) && missing(i.id, st.faces).length)) await dropLegacy();
    else if (legacy) await writeCache(legacy, LEGACY_FAMILY);
    remember();
    await remembering;
    if (again && !queued) queued = lib; // the photos that went away meanwhile, and entries made elsewhere: once more
    if (notIndexer) { // another device became the indexer meanwhile: this phone only searches from now on
      indexes = false; await saveSettings({ indexes: false }); dropOtherModels(clip, false); N.visionOpen(modelPath(), st.faces, clip, false).catch(() => {});
      if (live()) set({ phase: "ready", done: tags.size, total });
      return;
    }
    if (live()) set({ phase: "ready", done, total });
  } catch (e) {
    failed = true;
    if (e instanceof NeedsConsent) { if (live()) set({ phase: "consent", done: 0, total: e.bytes, message: undefined }); }
    else if (live()) set({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (run === mine) { release(); syncing = false; } // a newer run took over: it holds (or lets go) itself
    if (active === mine) {
      active = null;
      // a library that came while this ran: once more with it (not after a failure, which waits for the next change)
      const next = queued;
      queued = null;
      if (next && live() && !failed) setTimeout(() => { if (!active) startSearch(next).catch(() => {}); }, 0);
    }
  }
}

/**
 * The library changed (a refresh, live updates): search follows. A run still going isn't thrown away, as startSearch
 * would (it starts again from asking the server, which on a new account with a backup running meant starting over
 * every few seconds, never getting far into indexing): it takes the new photos into what it indexes, and runs once
 * more when it is done. With nothing running, it is startSearch.
 */
export function libraryChanged(library: Item[]): Promise<void> {
  if (active && !active.cancelled) { queued = library; return Promise.resolve(); }
  return startSearch(library);
}

export const stopSearch = () => { if (run) run.cancelled = true; queued = null; release(); };

/** "Index on this phone instead": this phone becomes the account's indexing device and loads the image models. */
export async function indexHere(library: Item[]) {
  await api("PUT", "/api/me/indexer");
  await refreshMe().catch(() => null);
  await startSearch(library);
}

/** MobileCLIP's entries on the server (left from before the one model), fetched only by the phone that indexes, while
 *  photos are missing the new entry; null when there are none. */
async function fetchLegacy(): Promise<Cache | null> {
  try {
    const c = await readCache(LEGACY_FAMILY);
    await fetchEntries(c, LEGACY_FAMILY);
    await writeCache(c, LEGACY_FAMILY);
    return Object.keys(c.entries).length ? c : null;
  } catch { return null; /* the faces are found again */ }
}

async function dropLegacy() {
  try { await api("DELETE", `/api/index?model=${LEGACY_FAMILY}`); } catch { return; /* next time */ }
  try { const f = cacheFile(LEGACY_FAMILY); if (f?.exists) f.delete(); } catch { /* only a cache */ }
}

/** The opened index of MobileCLIP's entries an earlier version kept: it doesn't open with this model. */
function dropOldCopies() {
  const id = session().me?.user.id;
  if (!id || !/^[0-9A-Za-z_-]{1,64}$/.test(id)) return;
  try { const f = new File(new Directory(Paths.cache, "cf-ct"), id, `index-${LEGACY_FAMILY}.bin`); if (f.exists) f.delete(); } catch { /* next time */ }
}

/** The entries an item is missing (want: their models). Faces in its MobileCLIP entry (from before) are taken over,
 *  not looked for again: the people document names faces by their place in an entry. */
async function analyzeItem(s: Sodium, it: Item, faces: boolean, want: Clip[], legacy: Cache | null) {
  const old = faces ? legacy?.entries[it.id] : undefined;
  let known: IndexEntry["faces"];
  try {
    if (old) { const e = openIndexEntry(s, unb64(s, old), pair!, it.id); if (legacyFaces(e.m)) known = e.faces ?? []; }
  } catch { /* found again */ }
  return analyzeBytes(await imageBytes(it), faces, want, known);
}

/** The entries for one picture, one per model in models (the bytes are wiped); faces are found once and go into each,
 *  or are those given (known). One with nothing to see in it (not an image, or a sliver) gets empty entries, stored
 *  like any other: they never match a search, and aren't tried again at every start. */
export async function analyzeBytes(bytes: Uint8Array, faces: boolean, models: Clip[], known?: IndexEntry["faces"]): Promise<IndexEntry[]> {
  let a: Analysis;
  try {
    a = await N.visionAnalyze(bytes, faces && !known, models);
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "ERR_UNUSABLE_IMAGE") return models.map((m) => ({ v: 1, m: modelTag(m, faces), ...(faces ? { faces: known ?? [] } : {}) }));
    throw e;
  } finally {
    bytes.fill(0);
  }
  const s = await getSodium();
  const found = faces ? known ?? (a.faces ?? []).map((f) => ({ box: f.box, score: f.score, emb: b64(s, f.emb) })) : undefined;
  return models.map((m, i) => toEntry(s, a.clips[i], found, m));
}

/** faces: undefined where faces are off */
export function toEntry(s: Sodium, clipVec: Uint8Array, faces: IndexEntry["faces"], model: Clip): IndexEntry {
  return { v: 1, m: modelTag(model, !!faces), clip: b64(s, clipVec), ...(faces ? { faces } : {}) };
}

// ---- for the background (search/background.ts): which phone photos are in the library, and which are done ----

export const localFile = () => new File(settingsDir(), "local.json");
/** Each item's fingerprint, worked out once: this runs every 50 photos indexed, over the whole library. */
const printOf = new Map<string, string>();
async function rememberForBackground(library: Item[], st: SearchSettings, live: () => boolean = () => true) {
  if (!st.background) return;
  const prints: Record<string, string> = {};
  let n = 0;
  for (const it of library) {
    if (!it.meta || it.broken) continue;
    const k = `${it.id}\0${it.meta.name}\0${it.meta.size}`;
    let p = printOf.get(k);
    if (p === undefined) { p = await fingerprint(it.meta.name, it.meta.size); printOf.set(k, p); if (++n % 500 === 0) { await pause(); if (!live()) return; } }
    prints[p] = it.id;
  }
  const done = library.filter((i) => good(tags.get(i.id), st.faces) && !missing(i.id, st.faces).length).map((i) => i.id);
  if (!live()) return; // (it isn't waited for: the library may have locked meanwhile)
  try { settingsDir().create({ intermediates: true, idempotent: true }); await localFile().write(JSON.stringify({ userId: session().me?.user.id, prints, done })); } catch { /* next time */ }
}

// ---- queries ----

let tokenizer: Tokenizer | null = null;

/** Every indexed item, best match for the words first: ranked like Immich's smart search, with no cut-off (the list
 *  shows page by page as it scrolls; filters narrow it in search/query.ts). Filtered (docs/SEARCH.md "Explicit
 *  content"): words close to explicit content find nothing, and photos that look explicit are left out. */
export async function textSearch(q: string, limit = 100_000): Promise<Hit[]> {
  if (!ready) return [];
  await openVision(await loadSettings(), false); // (the background closes the models when it ran while the app was away)
  await giveConcepts();
  tokenizer ??= new Tokenizer(JSON.parse(await tokenizerFile().text()));
  const vec = await N.visionText(tokenizer.encode(q));
  const f = filtered;
  if (f && queryBlocked(floats(vec))) return [];
  return N.indexSearch(vec, limit, -1, f);
}

/** little-endian float32 bytes (the native text vector) as numbers */
const floats = (b: Uint8Array) => new Float32Array(Uint8Array.from(b).buffer);

/** Duplicates and similar photos (app/duplicates.tsx): which items have a vector of the model in use, and the cosine
 *  of pairs (NaN where one has none). Nothing while search isn't ready on this phone. */
export const indexedAmong = async (ids: string[]): Promise<Set<string>> => {
  if (!ready) return new Set();
  const has = await N.indexHasAll(ids);
  return new Set(ids.filter((_, k) => has[k]));
};
export const pairScores = async (a: string[], b: string[]): Promise<number[]> =>
  (ready ? (await N.indexScores(a, b)).map((s) => (s < -1.5 ? NaN : s)) : a.map(() => NaN));

export const similarTo = (id: string) => (ready ? N.indexSimilar(id, 60, 0.6) : Promise.resolve([]));

/** Turns search off on this phone; with clear also the index on the server (entries of every device). */
export async function forgetSearch(clear: boolean) {
  stopSearch();
  try { await api("DELETE", "/api/me/indexer"); } catch { /* the next device that indexes takes over anyway once this one signs out */ }
  N.indexClear(); forgetTags(); ready = false; changed++;
  try { const d = new Directory(Paths.cache, "cf-ct"); if (d.exists) d.delete(); } catch { /* best effort */ }
  try { if (localFile().exists) localFile().delete(); } catch { /* best effort */ }
  if (clear) await api("DELETE", "/api/index");
  set({ phase: "off", done: 0, total: 0, message: undefined });
}

onWipe((how) => {
  if (run) run.cancelled = true;
  queued = null; printOf.clear();
  if (how !== "locked" || !downloading) release(); // a download goes on while locked (above)
  wipes++;
  N.indexClear?.();
  forgetTags();
  if (pair) { pair.sk.fill(0); pair = null; }
  ready = false; changed++;
  set({ phase: "off", done: 0, total: 0, message: undefined });
});
