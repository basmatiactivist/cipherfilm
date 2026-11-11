// Encrypts a shared file on the phone and uploads it, part by part, exactly like the web client: the same segment
// format, keys and metadata, so the web app and cipherfilm-decrypt read it. Only ciphertext leaves the phone.
import { getSodium, b64 } from "@crypto/sodium";
import { cipherLen, encryptSegment, segmentCount, segmentPlainLen, SEG_PLAIN } from "@crypto/file";
import { encryptMeta, encryptPreview, encryptThumb, newItemKey, wrapItemKey } from "@crypto/item";
type Sodium = Awaited<ReturnType<typeof getSodium>>;
import N from "../modules/cf-native/src/CfNativeModule";
import { api, putBytes, type Remote } from "./api";
import { session } from "./session";
import { keepRunning, letGo, onlyHolder } from "./keepAlive";
import type { ItemMeta } from "./library";
import { locale, t, tn } from "./i18n";
import { bounded } from "./bounded";
import { kindOf } from "./kind";
import { videoLocationOf } from "./videoGps";

export const THUMB_PX = 640;
export const PREVIEW_PX = 2048;
const SEGMENTS_IN_FLIGHT = 2;
const MAX_FILE = 8 * 1024 ** 3;
const ITEM_ID = /^[0-9a-f]{32}$/;

export interface Shared { uri: string; name: string; size: number; mime: string; deletable: boolean }

/** Name, size and type of a shared file, from the share itself or from Android's content provider. */
export async function describe(uri: string, hint?: { name?: string | null; size?: number | null; mime?: string | null }): Promise<Shared> {
  const st = await N.stat(uri);
  return { uri, name: st.name || hint?.name || "photo", size: st.size >= 0 ? st.size : hint?.size ?? -1, mime: st.mime || hint?.mime || "application/octet-stream", deletable: st.deletable };
}

const one = (n: number) => n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtSize = (n: number) => (n >= 1e9 ? `${one(n / 1e9)} GB` : n >= 1e6 ? `${one(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3)).toLocaleString(locale())} KB`);

/** What a share from another app would upload, and into which account: shown before anything is sent. */
export function shareSummary(files: Pick<Shared, "size">[], email: string): string {
  const total = files.reduce((a, f) => a + Math.max(0, f.size), 0);
  return tn(files.length, "{n} file ({size}) to encrypt and upload to {email}.", "{n} files ({size}) to encrypt and upload to {email}.", { size: fmtSize(total), email });
}

export { kindOf } from "./kind";

/** Uploads in progress: the app doesn't lock itself while one runs (but once they are over, autolock.ts). */
let running = 0;
export const uploadsRunning = () => running;
const idle = new Set<() => void>();
/** Called each time the last running upload ends (the next file of a share may start right after). */
export const onUploadsIdle = (f: () => void) => { idle.add(f); return () => { idle.delete(f); }; };

// ---- the one notification for uploads from the app (a share, or Upload in Photos) ----

let shownAt = 0;
/** Updates the uploads' notification in place (the foreground service's, keepAlive.ts): which file, n of m, how far
 *  overall. Never a notification per file. While the backup runs too, its progress shows instead. */
export function showUploads(n: number, total: number, name: string, progress: number, force = false) {
  const now = Date.now();
  if (!onlyHolder("upload") || (!force && now - shownAt < 1000)) return; // Android drops updates that come faster
  shownAt = now;
  N.backupNotify(total === 1 ? t("Uploading to Cipherfilm") : t("Uploading {n} of {total}", { n: Math.min(n, total), total }), name, progress, true);
}

/** The one notification after the uploads: how many went, how many didn't. */
export function uploadsSummary(ok: number, failed: number): { title: string; text: string } | null {
  if (!ok && !failed) return null;
  const went = tn(ok, "{n} file uploaded.", "{n} files uploaded.");
  if (!failed) return { title: t("Upload done"), text: went };
  const lost = tn(failed, "{n} file didn't upload.", "{n} files didn't upload.");
  return { title: t("Upload incomplete"), text: `${ok ? `${went} ` : ""}${lost} ${t("Open Cipherfilm to try again.")}` };
}

export class SignedOut extends Error {
  constructor() { super(t("Stopped: you signed out or locked the app.")); }
}

/** Uploads one file. onProgress gets plaintext bytes done. Resolves with the new item's id once the server has it. */
export async function uploadShared(f: Shared, onProgress: (done: number, total: number) => void, signal: { cancelled: boolean }): Promise<string> {
  if (f.size < 0) throw new Error(t("Can't upload: Android didn't report the file size."));
  if (f.size > MAX_FILE) throw new Error(t("Files over 8 GB can't be uploaded."));
  if (f.size === 0) throw new Error(t("The file is empty (0 bytes)."));
  const s = await getSodium();
  const { me, masterKey } = session();
  if (!me || !masterKey) throw new SignedOut();
  const owner = me.user.id;
  // bound to the session that started it: after a sign-out or lock it stops before sending anything more
  const mine = () => { const now = session(); if (signal.cancelled || now.me?.user.id !== owner || now.masterKey !== masterKey) throw new SignedOut(); };

  mine();
  running++;
  // goes on when the person leaves the app (TransferService)
  keepRunning("upload", t("Uploading to Cipherfilm"), f.name);
  try {
    return await uploadFile(f, s, (itemKey, id) => wrapItemKey(s, itemKey, masterKey, id), mine, onProgress);
  } finally {
    running--;
    letGo("upload");
    if (!running) idle.forEach((f) => f());
  }
}

/** SHA-256 part by part through the native module (the state crosses back and forth); null once anything fails. */
function sha256Start(): Uint8Array | null {
  try { return typeof N.sha256_init === "function" ? N.sha256_init() : null; } catch { return null; }
}
function sha256Add(state: Uint8Array | null, part: Uint8Array): Uint8Array | null {
  if (!state || !part.length) return state;
  try { return N.sha256_update(state, part); } catch { return null; }
}
function sha256End(s: Sodium, state: Uint8Array | null): { sha256?: string } {
  if (!state) return {};
  try { return { sha256: s.to_hex(N.sha256_final(state)) }; } catch { return {}; }
}

/** The upload itself. wrap() locks the new item key: under the master key, or sealed to the account's public key by
 *  the background backup. mine() throws to stop between steps. The backup passes its own server in to. */
const DECODE_MS = 90_000; // a thumbnail or a video frame; seconds even for very large files
const READ_MS = 120_000; // one part of the file (4 MB) from local storage

export async function uploadFile(f: Shared, s: Sodium, wrap: (itemKey: Uint8Array, id: string) => Uint8Array, mine: () => void, onProgress: (done: number, total: number) => void, to?: Remote): Promise<string> {
  if (f.size < 0) throw new Error(t("Can't upload: Android didn't report the file size."));
  if (f.size > MAX_FILE) throw new Error(t("Files over 8 GB can't be uploaded."));
  if (f.size === 0) throw new Error(t("The file is empty (0 bytes)."));
  const kind = kindOf(f);
  const count = segmentCount(f.size);
  const id = (await api<{ id: string }>("POST", "/api/items", { kind, size: f.size, segment_count: count }, to)).id;
  // the id is bound into the wrapped key and every part, and goes into the paths below: only one of the server's own form
  if (typeof id !== "string" || !ITEM_ID.test(id)) throw new Error(t("The server sent an invalid item id."));
  const itemKey = newItemKey(s);
  const wrapped = b64(s, wrap(itemKey, id));
  try {
    // thumbnails while the parts upload; a file Android can't decode still uploads, without a thumbnail
    let dims: { width?: number; height?: number } = {};
    const thumbWork = (async () => {
      if (kind === "other") return;
      try {
        const [th, p] = await Promise.all([bounded(N.jpeg(f.uri, kind === "video", THUMB_PX, 82), DECODE_MS), bounded(N.jpeg(f.uri, kind === "video", PREVIEW_PX, 85), DECODE_MS)]);
        if (!th || !p) return;
        dims = { width: p.width, height: p.height };
        mine();
        await Promise.all([putBytes(`/api/items/${id}/thumb`, encryptThumb(s, th.bytes, itemKey, id), to), putBytes(`/api/items/${id}/preview`, encryptPreview(s, p.bytes, itemKey, id), to)]);
      } catch (e) {
        if (e instanceof SignedOut) throw e;
      }
    })();
    const infoWork = bounded(N.mediaInfo(f.uri, kind === "video"), DECODE_MS).catch(() => ({}));

    // the original's SHA-256 for the metadata (finding the same file again, docs/CRYPTO.md): from the parts as they
    // are read, in native code; without it (an older native build, an error) the field is simply left out
    let hash = sha256Start();

    let done = 0;
    onProgress(0, f.size || 1);
    const inflight = new Set<Promise<void>>();
    let failure: unknown;
    for (let i = 0; i < count && failure === undefined; i++) {
      mine();
      const len = f.size === 0 ? 0 : segmentPlainLen(f.size, i);
      const plain = len ? await bounded(N.readRange(f.uri, i * SEG_PLAIN, len), READ_MS) : new Uint8Array(0);
      hash = sha256Add(hash, plain);
      const ct = encryptSegment(s, itemKey, id, i, count, f.size, plain);
      plain.fill(0);
      if (ct.length !== cipherLen(len)) throw new Error("internal size error");
      const put: Promise<void> = putBytes(`/api/items/${id}/segments/${i}`, ct, to)
        .then(() => { done += len; onProgress(Math.min(done, f.size), f.size || 1); }, (e) => { failure ??= e; })
        .finally(() => { inflight.delete(put); });
      inflight.add(put);
      if (inflight.size >= SEGMENTS_IN_FLIGHT) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    await thumbWork;
    if (failure !== undefined) throw failure;

    const info: Awaited<ReturnType<typeof N.mediaInfo>> = await infoWork;
    // Android reads a video's location only from udta/©xyz; the iPhone's form (a meta box) is read here
    if (kind === "video" && info.lat == null) Object.assign(info, (await videoLocationOf(f.uri, f.size)) ?? {});
    const now = Date.now();
    const meta: ItemMeta = {
      name: f.name, mime: f.mime, size: f.size, lastModified: now, capture_ts: info.captureTs ?? now,
      width: info.width ?? dims.width, height: info.height ?? dims.height, duration: info.duration,
      ...(info.make ? { make: info.make } : {}), ...(info.model ? { model: info.model } : {}),
      ...(info.lat != null && info.lon != null ? { gps: { lat: info.lat, lon: info.lon } } : {}),
      ...sha256End(s, hash),
    };
    mine();
    await api("POST", `/api/items/${id}/finalize`, { wrapped_item_key: wrapped, meta_enc: b64(s, encryptMeta(s, meta, itemKey, id)) }, to);
    return id;
  } catch (e) {
    // an unfinished upload is discarded right away instead of waiting two days for the server's cleanup
    api("DELETE", `/api/items/${id}`, undefined, to).catch(() => {});
    throw e;
  } finally {
    s.memzero(itemKey);
  }
}
