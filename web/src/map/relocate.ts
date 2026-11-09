// Where videos were filmed, added afterwards (docs/MAP.md): before 2.6.1 no app read a video's location at upload, so
// videos never showed on the map. While the map is on, this browser reads it from the encrypted original (only the
// box headers and the moov box, see videoLocation.ts) and writes it into the item's encrypted details; the other devices
// get it with the next change list. Photos already got theirs at upload.
import { api, getBytes } from "../api";
import { b64, getSodium } from "../crypto/sodium";
import { decryptSegment, SEG_PLAIN } from "../crypto/file";
import { encryptMeta } from "../crypto/item";
import { mem } from "../state";
import type { Item } from "../items";
import { coords } from "./locations";
import { videoLocation } from "../places/videoLocation";

const key = () => `cf-relocated:${mem.me?.user.id ?? ""}`;
const PER_RUN = 25; // videos looked at in one go; the rest the next time

function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key()) ?? "[]") as string[]); } catch { return new Set(); }
}
// signing out removes these with the upload memory (items.ts clearUploadMemory)
function saveDone(done: Set<string>) {
  try { localStorage.setItem(key(), JSON.stringify([...done])); } catch { /* looked at again next time */ }
}
/** Videos that could still get a location: finished, decrypted, none yet, not looked at before. */
export const lackingVideos = (items: Item[], done: Set<string>) =>
  items.filter((it) => it.kind === "video" && !it.broken && !it.trashed_at && it.meta && it.itemKey && !coords(it) && !done.has(it.id));

/** Reads a stored item's plain bytes by range, decrypting only the segments the range touches. */
export function segmentReader(it: Item, fetchSegment: (i: number) => Promise<Uint8Array>) {
  const cache = new Map<number, Uint8Array>();
  const seg = async (i: number) => {
    let p = cache.get(i);
    if (!p) {
      p = await fetchSegment(i);
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(i, p);
    }
    return p;
  };
  return async (offset: number, length: number): Promise<Uint8Array> => {
    const end = Math.min(it.size, offset + length);
    if (offset >= end) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);
    for (let o = offset; o < end;) {
      const i = Math.floor(o / SEG_PLAIN), within = o - i * SEG_PLAIN;
      const p = await seg(i);
      const n = Math.min(p.length - within, end - o);
      if (n <= 0) break;
      out.set(p.subarray(within, within + n), o - offset);
      o += n;
    }
    return out;
  };
}

let running: Promise<number> | null = null;

/** Adds the location to videos that lack it; resolves with how many got one. */
export function relocateVideos(items: Item[]): Promise<number> {
  if (running) return running;
  running = run(items).finally(() => { running = null; });
  return running;
}

async function run(items: Item[]): Promise<number> {
  if (!mem.me || mem.me.demo || !mem.masterKey) return 0;
  const owner = mem.me.user.id;
  const done = loadDone();
  const todo = lackingVideos(items, done).slice(0, PER_RUN);
  if (!todo.length) return 0;
  const s = await getSodium();
  let added = 0;
  for (const it of todo) {
    if (mem.me?.user.id !== owner || !mem.masterKey) break; // locked or signed out meanwhile
    try {
      const read = segmentReader(it, async (i) => decryptSegment(s, it.itemKey!, it.id, i, it.segment_count, it.size, await getBytes(`/api/items/${it.id}/segments/${i}`)));
      const g = await videoLocation(it.size, read);
      if (g) {
        await api("PUT", `/api/items/${it.id}/meta`, { meta_enc: b64(s, encryptMeta(s, { ...it.meta!, gps: g }, it.itemKey!, it.id)) });
        added++;
      }
      done.add(it.id);
    } catch {
      // not reachable now: looked at again next time
    }
  }
  saveDone(done);
  return added;
}
