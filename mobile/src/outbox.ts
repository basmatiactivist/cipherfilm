// Decrypted copies for leaving the app: sharing to another app, or saving into the phone's own photo library. They are
// written to one folder in the app's cache, which Android never backs up and other apps can't list; a share hands out
// read access to exactly the shared files. The folder is emptied (and that access taken back) before every new share,
// when the app starts, at every lock, and when it comes back after a while (the receiving app may still be reading
// right after the share sheet closes). If Android ends the app before any of that, a native job removes the copies
// after the same while (Outbox.kt), so they never wait for the next start.
import { Directory, File, Paths } from "expo-file-system";
import { getSodium } from "@crypto/sodium";
import { decryptSegment } from "@crypto/file";
import N from "../modules/cf-native/src/CfNativeModule";
import { getBytes } from "./api";
import type { Item } from "./library";
import { onWipe, session } from "./session";
import { away } from "./autolock";
import { t } from "./i18n";
import { leavesAs } from "@edit/edit";

export const OUT = () => new Directory(Paths.cache, "cf-out");
const KEEP_FOR = 15 * 60 * 1000;
let lastShare = 0;

/** The outbox has new decrypted copies: the native job removes them after KEEP_FOR even if the app isn't running. */
export function sweepLater() {
  try { N.outboxSweepLater(); } catch { /* the app's own clean-ups still run */ }
}

export function clearOutbox() {
  try { N.revokeShared(); } catch { /* nothing shared */ }
  try { const d = OUT(); if (d.exists) d.delete(); } catch { /* nothing to remove */ }
}

// decrypted copies don't outlive the unlocked session
onWipe(() => clearOutbox());

/** Called when the app comes to the foreground: copies from an old share are not kept around. */
export function tidyOutbox() {
  if (!lastShare || Date.now() - lastShare > KEEP_FOR) clearOutbox();
}

/** A file name that is safe to hand to another app: no path separators or control characters, never empty. */
export function safeName(name: string | undefined, id: string, used: Set<string>): string {
  let n = (name ?? "").replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || `photo-${id.slice(0, 8)}`;
  const dot = n.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base} (${i})${ext}`;
  used.add(n.toLowerCase());
  return n;
}

/** Downloads and decrypts one original into the outbox, part by part (large videos never sit in memory whole). */
export async function decryptTo(dir: Directory, it: Item, used: Set<string>, onBytes: (n: number) => void): Promise<File> {
  if (!session().masterKey) throw new Error(t("Unlock your library first."));
  if (!it.itemKey || !it.meta) throw new Error(t("This item couldn't be verified."));
  const s = await getSodium();
  const f = new File(dir, safeName(it.meta.name, it.id, used));
  f.create();
  const h = f.open();
  try {
    for (let i = 0; i < it.segment_count; i++) {
      const ct = await getBytes(`/api/items/${it.id}/segments/${i}`);
      const plain = decryptSegment(s, it.itemKey, it.id, i, it.segment_count, it.size, ct);
      h.writeBytesSync(plain); // written before the plaintext is wiped below
      onBytes(plain.length);
      plain.fill(0);
    }
  } catch (e) {
    h.close();
    f.delete();
    throw e;
  }
  h.close();
  // never hand out a file that isn't complete: a short one would arrive as an empty or broken attachment
  if (f.size !== it.size) { f.delete(); throw new Error(t("“{name}” couldn't be prepared. Try again.", { name: it.meta.name })); }
  return f;
}

const mimeOf = (it: Item) => it.meta?.mime || (it.kind === "video" ? "video/mp4" : it.kind === "image" ? "image/jpeg" : "application/octet-stream");

/** How a photo leaves the app unless the original is asked for (@edit/edit leavesAs): turned or cropped as edited (a
 *  JPEG made here, edit.ts); with only its date or place changed as its own JPEG with the metadata as set ("retag", a
 *  removed place is in no part of the file) or, in another format, drawn anew as a JPEG; everything else (videos too)
 *  as the original. Photos over the edit limit leave as the original. */
export function leaving(it: Item, original?: boolean): "edited" | "retag" | "redraw" | "original" {
  if (original || it.size > 200 * 1024 * 1024) return "original"; // edit.ts EDIT_LIMIT
  return leavesAs(it.kind, it.meta, it.stale);
}
// (edit.ts, with the image manipulator, is loaded only when an edited photo leaves the app)
const copyOf = async (dir: Directory, it: Item, used: Set<string>, onBytes: (n: number) => void, original?: boolean) => {
  const how = leaving(it, original);
  if (how === "original") return decryptTo(dir, it, used, onBytes);
  const edit = await import("./edit");
  return how === "retag" ? edit.retaggedCopyTo(dir, it, used, onBytes) : edit.editedCopyTo(dir, it, used, onBytes);
};
const mimeOut = (it: Item, original?: boolean) => (leaving(it, original) === "original" ? mimeOf(it) : "image/jpeg");

/** Decrypts the items for sharing; send() then opens Android's share sheet with them. */
export async function prepareShare(items: Item[], onProgress: (done: number, total: number) => void, opts?: { original?: boolean }): Promise<{ send: () => Promise<boolean> }> {
  clearOutbox();
  const dir = new Directory(OUT(), (await getSodium()).to_hex((await getSodium()).randombytes_buf(16)));
  dir.create({ intermediates: true, idempotent: true });
  sweepLater();
  const total = items.reduce((a, i) => a + i.size, 0);
  let done = 0;
  const used = new Set<string>();
  const files: File[] = [];
  for (const it of items) files.push(await copyOf(dir, it, used, (n) => onProgress((done += n), total), opts?.original));
  return {
    send: () => {
      lastShare = Date.now();
      return away(() => N.shareFiles(files.map((f) => f.uri), items.map((it) => mimeOut(it, opts?.original))));
    },
  };
}

/** Saves decrypted copies into the phone's photo library; the temporary copies are removed right after. */
export async function saveItems(items: Item[], onProgress: (done: number, total: number) => void, opts?: { original?: boolean }) {
  const dir = new Directory(OUT(), "save");
  dir.create({ intermediates: true, idempotent: true });
  sweepLater(); // a copy cut short by a crash mid-save, too
  const total = items.reduce((a, i) => a + i.size, 0);
  let done = 0;
  const used = new Set<string>();
  try {
    for (const it of items) {
      const f = await copyOf(dir, it, used, (n) => onProgress((done += n), total), opts?.original);
      try { await N.saveToLibrary(f.uri, f.name, mimeOut(it, opts?.original)); } finally { f.delete(); }
    }
  } finally {
    try { dir.delete(); } catch { /* already gone */ }
  }
}
