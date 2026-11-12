// The version of an item's encrypted metadata (docs/CRYPTO.md, "Metadata version"): `mv`, a counter inside the
// encrypted metadata that every change of it raises by one (an upload has none: version 0). The server can't change it
// (the metadata is sealed), but it could hand out an older sealed copy it kept, to bring back a removed place or undo
// an edit. Each device remembers the highest version it has seen of each item and never goes back to a lower one:
// in a session it keeps showing the newer metadata; after a restart (when only the number is known) the item is
// marked `stale`, and a share or download of it never hands out the original by default. Shared by the web app and
// the Android app (@crypto/metaVersion).

/** The metadata's version: its `mv`, or 0 (an upload, or a change by an app from before versions). */
export function metaVersion(meta: unknown): number {
  const v = (meta as { mv?: unknown } | null | undefined)?.mv;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** The metadata as the next change writes it: the version one higher. */
export function nextVersion<T extends object>(meta: T): T & { mv: number } {
  return { ...meta, mv: metaVersion(meta) + 1 };
}

/** How many items' versions are kept: those with a version above 0 only, the oldest noted dropped first. */
export const KEEP_VERSIONS = 10_000;

/**
 * The highest metadata version seen per item, for one account on this device. load/save keep it across restarts
 * (only item ids and numbers: nothing of the photos). check() says whether a version may be shown and notes it.
 */
export class HighWater {
  private seen: Map<string, number>;
  private dirty = false;

  constructor(private save?: (entries: [string, number][]) => void, loaded?: unknown, private max = KEEP_VERSIONS) {
    this.seen = new Map();
    if (Array.isArray(loaded)) {
      for (const e of loaded) {
        if (Array.isArray(e) && typeof e[0] === "string" && /^[0-9a-f]{32}$/.test(e[0]) && Number.isSafeInteger(e[1]) && e[1] > 0) this.seen.set(e[0], e[1]);
      }
    }
  }

  /** The highest version seen of an item; 0 when none above 0. */
  highest(id: string): number { return this.seen.get(id) ?? 0; }

  /** false: an older version than one seen before (a replay); true: as new or newer, and noted. */
  check(id: string, version: number): boolean {
    const was = this.seen.get(id) ?? 0;
    if (version < was) return false;
    if (version > was) {
      this.seen.delete(id); // newest noted last: the oldest go first when there are too many
      this.seen.set(id, version);
      while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
      this.dirty = true;
    }
    return true;
  }

  /** Writes what changed since the last flush (after a list was decrypted). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.save?.([...this.seen]);
  }
}
