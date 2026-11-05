// Search on the phone, while the library is unlocked: keeps the decrypted index in native memory (SearchIndex.kt),
// fetches entries other devices or the background made, and indexes what has none yet. Each entry is computed from the
// item's decrypted preview (or thumbnail), sealed to the account's public key and stored on the server, so it is
// computed once per photo, not once per device. A lock forgets all of it.
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

export type Phase = "off" | "waitWifi" | "download" | "loading" | "indexing" | "ready" | "error";
export interface Progress { phase: Phase; done: number; total: number; message?: string }

let progress: Progress = { phase: "off", done: 0, total: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<Progress>) => { progress = { ...progress, ...p }; subs.forEach((f) => f()); };
export const useSearchProgress = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => progress);
export const searchProgress = () => progress;

/** Which model made each item's entry: those from another model (or without faces, when faces are on) are redone. */
const tags = new Map<string, string>();
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
  if (!me?.user.nsfw || !masterKey) return "mobileclip-s2";
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
  try { if (f?.exists) return JSON.parse(await f.text()); } catch { /* start over */ }
  return { since: 0, entries: {} };
}
async function writeCache(c: Cache) {
  const f = cacheFile();
  if (!f) return;
  try { f.parentDirectory.create({ intermediates: true, idempotent: true }); await f.write(JSON.stringify(c)); } catch { /* only a cache */ }
}

function put(s: Sodium, id: string, e: IndexEntry, faces: boolean) {
  const fs = faces ? e.faces ?? [] : [];
  const embs = new Uint8Array(fs.length * 256);
  fs.forEach((f, i) => embs.set(unb64(s, f.emb).subarray(0, 256), i * 256));
  tags.set(id, e.m);
  return N.indexPut(id, e.clip ? unb64(s, e.clip) : null, fs.map((f) => f.box), fs.map((f) => f.score), embs);
}

const pause = () => new Promise((r) => setTimeout(r, 0));

// While it downloads the models or indexes, the app keeps running when it leaves the screen: the foreground service
// and its notification (as for uploads, keepAlive.ts), so neither stops until the app is opened again.
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
    const s = await getSodium();
    // the account as it is now: an admin may have allowed explicit search, another device may index since
    const now = await refreshMe().catch(() => me) ?? me;
    const want = await accountClip();
    if (!live()) return;
    indexes = indexesHere(now);
    // the other model's vectors don't compare, and its files go at once (not only when the new one downloads)
    if (want !== clip) { N.indexClear(); N.visionClose(); tags.clear(); ready = false; changed++; clip = want; }
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
      if (!live()) return;
    }
    set({ phase: "loading", done: 0, total: 0 });
    await N.visionOpen(modelPath(), st.faces, clip, indexes);
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
    let n = 0;
    for (const [id, enc] of Object.entries(cache.entries)) {
      if (!live()) return;
      if (!ids.has(id) || good(tags.get(id), st.faces) && N.indexHas(id)) continue;
      try { await put(s, id, openIndexEntry(s, unb64(s, enc), pair!, id), st.faces); } catch { delete cache.entries[id]; /* damaged or not for this item: made again */ }
      if (++n % 200 === 0) await pause();
    }
    for (const id of [...tags.keys()]) if (!ids.has(id)) { tags.delete(id); N.indexRemove(id); }
    ready = true; changed++;
    await rememberForBackground(library, st);

    // what has no entry yet: newest first; only on the phone that indexes (the others take what it stores)
    if (!indexes) { set({ phase: "ready", done: tags.size, total: ids.size, message: undefined }); return; }
    const todo = library.filter((i) => !i.broken && i.itemKey && i.kind !== "other" && (i.has_preview || i.has_thumb) && !good(tags.get(i.id), st.faces));
    const total = ids.size;
    let done = total - todo.length;
    set({ phase: todo.length ? "indexing" : "ready", done, total, message: undefined });
    if (todo.length) hold("Indexing for search", `${done} of ${total}`);
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
          cache.entries[it.id] = enc;
          await put(s, it.id, entry, st.faces);
          changed++;
        } catch (e) {
          if ((e as { status?: number }).status === 0) throw e; // offline: stop, try again later
          if (e instanceof ApiError && e.code === "not_indexer") { notIndexer = true; todo.length = 0; return; }
        }
        done++;
        if (++since % 10 === 0) { set({ done }); show("Indexing for search", `${done} of ${total}`, done, total); }
        if (since % 50 === 0) { await writeCache(cache); await rememberForBackground(library, st); }
      }
    };
    await Promise.all([work(), work()]);
    await writeCache(cache);
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
    if (run === mine) release(); // a newer run took over: it holds (or lets go) itself
  }
}

export const stopSearch = () => { if (run) run.cancelled = true; release(); };

/** "Index on this phone instead": this phone becomes the account's indexing device and loads the image models. */
export async function indexHere(library: Item[]) {
  await api("PUT", "/api/me/indexer");
  await refreshMe().catch(() => null);
  await startSearch(library);
}

async function analyzeItem(it: Item, faces: boolean): Promise<IndexEntry> {
  const bytes = await imageBytes(it);
  let a: Analysis;
  try { a = await N.visionAnalyze(bytes, faces); } finally { bytes.fill(0); }
  return toEntry(await getSodium(), a, faces, clip);
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
  tokenizer ??= new Tokenizer(JSON.parse(await tokenizerFile().text()));
  const vec = await N.visionText(tokenizer.encode(q));
  return N.indexSearch(vec, limit, -1);
}

export const similarTo = (id: string) => (ready ? N.indexSimilar(id, 60, 0.6) : Promise.resolve([]));

/** Turns search off on this phone; with clear also the index on the server (entries of every device). */
export async function forgetSearch(clear: boolean) {
  stopSearch();
  try { await api("DELETE", "/api/me/indexer"); } catch { /* the next device that indexes takes over anyway once this one signs out */ }
  N.indexClear(); tags.clear(); ready = false; changed++;
  try { const d = new Directory(Paths.cache, "cf-ct"); if (d.exists) d.delete(); } catch { /* best effort */ }
  try { if (localFile().exists) localFile().delete(); } catch { /* best effort */ }
  if (clear) await api("DELETE", "/api/index");
  set({ phase: "off", done: 0, total: 0, message: undefined });
}

onWipe(() => {
  stopSearch();
  N.indexClear?.();
  tags.clear();
  if (pair) { pair.sk.fill(0); pair = null; }
  ready = false; changed++;
  set({ phase: "off", done: 0, total: 0, message: undefined });
});
