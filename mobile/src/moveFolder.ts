// Moving items between the library, the archive and the locked folder (docs/EDITING.md, "Archive and locked folder").
// Where an item is goes INSIDE its encrypted metadata (@edit/folders withFolder), written like any edit: the version
// raised (@crypto/metaVersion), sealed with the item key, PUT /api/items/{id}/meta. Every other field stays as it is.
// The server sees only that an item's metadata changed, never which folder it is in.
import { folderOf, withFolder, type Folder } from "@edit/folders";
import { forgetPictures, loadLibrary, MetaChanged, writable, writeMeta, type Item } from "./library";
import { session } from "./session";
import { t } from "./i18n";

export type { Folder };

/** Whether the person may move items here (the public demo refuses changes, like editing). */
export const canMove = () => !session().me?.demo;

/** Whether this item can be moved at all: decrypted, with its key, not stale (its metadata is older than one seen
 *  before: writing it would bring back what changed since), not in the trash. */
export const movable = (it: Item) => writable(it) && !it.trashed_at;

export interface Moved { moved: string[]; failed: number }

/**
 * Moves items into `to`, one PUT per item, a few at a time; `onProgress` counts them. What is there already counts as
 * moved; what can't be moved (or whose PUT fails) counts as failed, and the rest go on. One another device changed
 * meanwhile (library.ts writeMeta) is loaded again and moved from its current metadata. Moving into the locked folder
 * also deletes what this phone keeps of the item (its cached encrypted thumbnail and preview, the native bitmap).
 * The caller reloads the library afterwards.
 */
export async function moveTo(items: Item[], to: Folder, onProgress?: (done: number, total: number) => void): Promise<Moved> {
  if (!canMove()) throw new Error(t("This is the public demo: changes are turned off."));
  const master = session().masterKey;
  if (!master) throw new Error(t("Unlock your library first."));
  const moved: string[] = [], changed: Item[] = [];
  let failed = 0, done = 0;
  const queue = [...items];
  const one = async (it: Item, again = false) => {
    if (!movable(it)) { failed++; return; }
    if (folderOf(it.meta) === to) { moved.push(it.id); return; }
    if (session().masterKey !== master) throw new Error(t("Unlock your library first.")); // locked meanwhile
    try {
      await writeMeta(it, withFolder(it.meta!, to));
      moved.push(it.id);
      if (to === "locked") forgetPictures(it.id);
    } catch (e) {
      if (e instanceof MetaChanged && !again) changed.push(it);
      else failed++;
    }
  };
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      await one(it);
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  if (changed.length) {
    // changed on another device meanwhile: once more, from the metadata as it is now
    const fresh = new Map((await loadLibrary().catch(() => [] as Item[])).map((it) => [it.id, it]));
    for (const old of changed) {
      const it = fresh.get(old.id);
      if (it) await one(it, true); else failed++;
    }
  }
  return { moved, failed };
}
