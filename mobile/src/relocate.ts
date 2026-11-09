// Where photos were taken, added afterwards (docs/MAP.md): photos and videos uploaded from this phone without their
// location — picked in the app before 2.6.1 (Android's photo picker hands out copies without it), backed up without
// the "where photos were taken" permission, or videos, whose location the app didn't read before — get it from the
// original still on the phone. Only while the map is on and Android lets the app read originals; the location goes
// into the item's encrypted details like at upload, and the other devices get it with the next change list.
import { Directory, File, Paths } from "expo-file-system";
import { b64, getSodium } from "@crypto/sodium";
import { encryptMeta } from "@crypto/item";
import N, { type PhoneMedia } from "../modules/cf-native/src/CfNativeModule";
import { api } from "./api";
import { onWipe, session } from "./session";
import { fingerprint } from "./prints";
import { videoLocationOf } from "./videoGps";
import { coords } from "./places";
import { libraryItems, refreshLibrary } from "./libraryStore";
import type { Item, ItemMeta } from "./library";

const STATE = () => new File(new Directory(Paths.document, "relocate"), "done.json");

/** The items already looked at for this account: their location was added, or the original has none. */
async function loadDone(userId: string): Promise<Set<string>> {
  try {
    const f = STATE();
    if (!f.exists) return new Set();
    const d = JSON.parse(await f.text()) as { userId?: string; done?: string[] };
    return d.userId === userId && Array.isArray(d.done) ? new Set(d.done) : new Set();
  } catch { return new Set(); }
}

function saveDone(userId: string, done: Set<string>) {
  try {
    const dir = new Directory(Paths.document, "relocate");
    if (!dir.exists) dir.create({ intermediates: true });
    STATE().write(JSON.stringify({ userId, done: [...done] }));
  } catch { /* looked at again next time */ }
}

/** The photo picker named what it handed out by its number in the phone's library ("812.jpg"). */
const pickerId = (name: string) => /^(\d+)\.[A-Za-z0-9]+$/.exec(name)?.[1];

/** The phone's file for each item without a location: same name and size, or the picker's number and same size. */
export async function matchOnPhone(items: Item[], media: PhoneMedia[]): Promise<Map<Item, PhoneMedia>> {
  const byPrint = new Map<string, PhoneMedia>();
  const byId = new Map<string, PhoneMedia>();
  for (const m of media) {
    if (m.size <= 0) continue;
    byPrint.set(await fingerprint(m.name, m.size), m);
    byId.set(String(m.id), m);
  }
  const out = new Map<Item, PhoneMedia>();
  for (const it of items) {
    const meta = it.meta;
    if (!meta || meta.size <= 0) continue;
    const m = byPrint.get(await fingerprint(meta.name, meta.size)) ?? (() => {
      const id = pickerId(meta.name);
      const c = id ? byId.get(id) : undefined;
      return c && c.size === meta.size ? c : undefined;
    })();
    if (m) out.set(it, m);
  }
  return out;
}

/** Items that could still get a location: finished, decrypted, a photo or video, none yet, not looked at before. */
export function lacking(items: Item[], done: Set<string>): Item[] {
  return items.filter((it) => !it.broken && !it.trashed_at && it.meta && it.itemKey && (it.kind === "image" || it.kind === "video")
    && !coords(it) && !done.has(it.id));
}

let running: Promise<number> | null = null;
let lastRun = 0;

/** Adds the location to what lacks it, at most every few minutes; resolves with how many items got one. */
export function relocate(opts?: { force?: boolean }): Promise<number> {
  if (running) return running;
  if (!opts?.force && Date.now() - lastRun < 5 * 60_000) return Promise.resolve(0);
  running = run().finally(() => { running = null; lastRun = Date.now(); });
  return running;
}

async function run(): Promise<number> {
  const me = session().me;
  if (!me || me.demo || !session().masterKey) return 0;
  // without the permission Android hands out copies without the location: nothing to learn, and nothing marked done
  if (!N.mediaLocationAllowed() || N.backupState().media === "none") return 0;
  const userId = me.user.id;
  const done = await loadDone(userId);
  const todo = lacking(libraryItems(), done);
  if (!todo.length) return 0;
  const found = await matchOnPhone(todo, await N.phoneMedia());
  const s = await getSodium();
  let added = 0;
  for (const [it, m] of found) {
    if (session().me?.user.id !== userId || !session().masterKey) break; // locked or signed out meanwhile
    try {
      const info = await N.mediaInfo(m.uri, it.kind === "video");
      if (it.kind === "video" && info.lat == null) Object.assign(info, (await videoLocationOf(m.uri, m.size)) ?? {});
      const { lat, lon } = info;
      if (typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
        const meta: ItemMeta = { ...it.meta!, gps: { lat, lon } };
        await api("PUT", `/api/items/${it.id}/meta`, { meta_enc: b64(s, encryptMeta(s, meta, it.itemKey!, it.id)) });
        added++;
      }
      done.add(it.id);
    } catch {
      // the server or the file wasn't reachable: tried again next time
    }
  }
  saveDone(userId, done);
  if (added) await refreshLibrary({ quiet: true }).catch(() => {});
  return added;
}

// signing out removes this phone's copy of everything about the account
onWipe((how) => {
  if (how === "ended") try { const d = new Directory(Paths.document, "relocate"); if (d.exists) d.delete(); } catch { /* best effort */ }
});
