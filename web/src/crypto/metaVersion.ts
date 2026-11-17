// The version of an item's encrypted metadata (docs/CRYPTO.md, "Metadata version"): `mv`, a counter inside the
// encrypted metadata that every change of it raises by one (an upload has none: version 0). The server can't change it
// (the metadata is sealed), but it could hand out an older sealed copy it kept, to bring back a removed place or undo
// an edit. Each device remembers the highest version it has seen of each item, and which sealed copy that was, and
// never goes back: in a session it keeps showing the newer metadata; after a restart (when only the number is known)
// the item is marked `stale`. A stale item is handled like a locked one (edit/folders.ts): no open view shows it,
// nothing of it is kept on disk, and nothing writes on top of it. Shared by the web app and the Android app
// (@crypto/metaVersion).
import { Sha256 } from "./sha256";

/** The metadata's version: its `mv`, or 0 (an upload, or a change by an app from before versions). */
export function metaVersion(meta: unknown): number {
  const v = (meta as { mv?: unknown } | null | undefined)?.mv;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** The metadata as the next change writes it: the version one higher. */
export function nextVersion<T extends object>(meta: T): T & { mv: number } {
  return { ...meta, mv: metaVersion(meta) + 1 };
}

/** Which sealed copy of the metadata this is: the SHA-256 (hex) of its meta_enc as the server lists it. A change sends
 *  it as its `base` (PUT /api/items/{id}/meta), so the server refuses it when the item changed meanwhile. */
export function metaDigest(metaEnc: string): string {
  const b = new Uint8Array(metaEnc.length);
  for (let i = 0; i < metaEnc.length; i++) b[i] = metaEnc.charCodeAt(i) & 0xff; // base64: ASCII only
  return new Sha256().update(b).hex();
}

/** How many items' versions are kept (those with a version above 0 only). Nothing is ever dropped to make room: when
 *  it is full, a further item's metadata can't be checked and is handled as stale. */
export const KEEP_VERSIONS = 50_000;

/** What is kept of a digest: 64 bits tell two sealed copies apart (the server can't choose either's bytes). */
const short = (d: string | undefined) => (d && /^[0-9a-f]{16,64}$/.test(d) ? d.slice(0, 16) : undefined);

/**
 * The highest metadata version seen per item, and which sealed copy it was, for one account on this device. load/save
 * keep it across restarts and locks (only item ids, numbers and digests: nothing of the photos); only the person's own
 * sign-out, deleting the account or leaving the server deletes it, never a session the server ended. check() says
 * whether a copy may be shown and notes it.
 */
export class HighWater {
  private seen: Map<string, { v: number; d?: string }>;
  private dirty = false;
  private save?: (entries: [string, number, string?][]) => void;
  private max: number;

  constructor(save?: (entries: [string, number, string?][]) => void, loaded?: unknown, max = KEEP_VERSIONS) {
    this.save = save;
    this.max = max;
    this.seen = new Map();
    if (Array.isArray(loaded)) {
      for (const e of loaded) {
        if (Array.isArray(e) && typeof e[0] === "string" && /^[0-9a-f]{32}$/.test(e[0]) && Number.isSafeInteger(e[1]) && e[1] > 0) {
          this.seen.set(e[0], { v: e[1], d: typeof e[2] === "string" ? short(e[2]) : undefined });
        }
      }
    }
  }

  /** The highest version seen of an item; 0 when none above 0. */
  highest(id: string): number { return this.seen.get(id)?.v ?? 0; }

  /** Whether this copy may be shown, without noting it: false for an older version than one seen (a replay), for
   *  another copy at the version seen (two changes made from the same older copy: only one is the one seen here), and
   *  for an item not seen before once the store is full (it can't be checked). */
  accepts(id: string, version: number, digest?: string): boolean {
    const was = this.seen.get(id);
    if (!was) return version === 0 || this.seen.size < this.max;
    if (version < was.v) return false;
    const d = short(digest);
    return !(version === was.v && d && was.d && d !== was.d);
  }

  /** accepts(), and notes the copy when it is accepted. */
  check(id: string, version: number, digest?: string): boolean {
    if (!this.accepts(id, version, digest)) return false;
    this.note(id, version, digest);
    return true;
  }

  /** This device wrote this copy itself (it is the newest it knows). */
  wrote(id: string, version: number, digest: string) {
    if (this.accepts(id, version, digest)) this.note(id, version, digest);
  }

  private note(id: string, version: number, digest?: string) {
    if (version === 0) return;
    const was = this.seen.get(id), d = short(digest);
    if (was && was.v === version && (was.d || !d)) return;
    this.seen.set(id, { v: version, d });
    this.dirty = true;
  }

  /** Writes what changed since the last flush (after a list was decrypted). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.save?.([...this.seen].map(([id, { v, d }]): [string, number, string?] => (d ? [id, v, d] : [id, v])));
  }
}
