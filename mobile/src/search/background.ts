// Search in the background (the same WorkManager task as the backup, about every 15 minutes when Android allows):
// photos on this phone that are in the library but have no index entry yet are indexed from the phone's own file, and
// the entry is sealed to the account's public key. No master key is needed, and none of the index can be read here.
// Photos that exist only on the server are indexed while the app is open (engine.ts).
import { AppState } from "react-native";
import { getSodium, b64, unb64, type Sodium } from "@crypto/sodium";
import { sealIndexEntry } from "@crypto/search";
import N from "../../modules/cf-native/src/CfNativeModule";
import { api, ApiError, setCsrf, setServer } from "../api";
import { fingerprint } from "../prints";
import { haveModels, modelPath, type Clip } from "./models";
import { loadSettings, saveSettings, type SearchSettings } from "./settings";
import { localFile, toEntry } from "./engine";

const BUDGET = 6 * 60_000;

/** Whether background indexing may run now; the reason in plain words if not. */
export function backgroundBlocker(st: SearchSettings): string | undefined {
  const d = N.backupState();
  if (!st.enabled || !st.background) return "off";
  if (st.indexes === false) return "Another device indexes your photos.";
  if (d.media === "none") return "Cipherfilm isn't allowed to see your photos.";
  if (!d.online) return "Waiting for an internet connection.";
  if (st.chargingOnly && !d.charging) return "Waiting until the phone is charging.";
  return undefined;
}

/** Indexes one file just uploaded by the backup, while it is still at hand. Errors are ignored: the app redoes it. */
export async function indexUploaded(s: Sodium, id: string, uri: string, video: boolean, pubkey: Uint8Array) {
  try {
    const st = await loadSettings();
    const clip = st.clip ?? "mobileclip-s2";
    const why = backgroundBlocker(st) ?? (!(await haveModels(st.faces, clip)) ? "models missing" : undefined);
    if (why) { if (why !== "off") console.log(`search index (upload): later, ${why}`); return; }
    await N.visionOpen(modelPath(), st.faces, clip, true);
    await indexFile(s, id, uri, video, st.faces, pubkey, clip);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_indexer") await saveSettings({ indexes: false }).catch(() => {});
    console.log(`search index (upload): skipped, ${e instanceof Error ? e.message : e}`); // the app indexes it later
  }
}

async function indexFile(s: Sodium, id: string, uri: string, video: boolean, faces: boolean, pubkey: Uint8Array, clip: Clip) {
  const img = await N.jpeg(uri, video, 2048, 90);
  if (!img) return;
  const a = await N.visionAnalyze(img.bytes, faces);
  img.bytes.fill(0);
  const entry = toEntry(s, a, faces, clip);
  // the tag in the clear too: where explicit search is allowed the server takes entries only with it (docs/SEARCH.md)
  await api("PUT", `/api/items/${id}/index`, { data_enc: b64(s, sealIndexEntry(s, entry, pubkey, id)), model: entry.m });
}

export async function runBackgroundIndex(): Promise<number> {
  const st = await loadSettings();
  if (backgroundBlocker(st) || !st.server || !st.pubkey || !st.userId) return 0;
  const f = localFile();
  if (!f.exists) return 0;
  let local: { userId: string; prints: Record<string, string>; done: string[] };
  try { local = JSON.parse(await f.text()); } catch { return 0; }
  const clip = st.clip ?? "mobileclip-s2";
  if (local.userId !== st.userId || !(await haveModels(st.faces, clip))) return 0;
  const done = new Set(local.done);
  const deadline = Date.now() + BUDGET;
  let n = 0;
  try {
    setServer(st.server);
    const me = await api<{ user: { id: string }; csrf: string }>("GET", "/api/me");
    if (me.user.id !== st.userId) return 0;
    setCsrf(me.csrf);
    const s = await getSodium();
    const pk = unb64(s, st.pubkey);
    const media = await N.phoneMedia();
    const todo: { id: string; uri: string; video: boolean }[] = [];
    for (const m of media.reverse()) { // newest first
      const id = local.prints[await fingerprint(m.name, m.size)];
      if (id && !done.has(id)) { todo.push({ id, uri: m.uri, video: m.mime?.startsWith("video/") }); done.add(id); }
    }
    if (!todo.length) return 0;
    await N.visionOpen(modelPath(), st.faces, clip, true);
    for (const t of todo) {
      if (Date.now() > deadline || backgroundBlocker(st)) break;
      try {
        await indexFile(s, t.id, t.uri, t.video, st.faces, pk, clip);
        local.done.push(t.id);
        n++;
        if (n % 20 === 0) await f.write(JSON.stringify(local));
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_indexer") { await saveSettings({ indexes: false }); break; }
        if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status >= 500)) break;
      }
    }
    await f.write(JSON.stringify(local));
  } catch { /* next time */ } finally {
    if (AppState.currentState !== "active") N.visionClose(); // the models take memory; the app opens them again
    console.log(`search index (background): ${n} indexed`);
  }
  return n;
}
