// Moving items between the library, the archive and the locked folder (docs/EDITING.md, "Archive and locked folder").
// Where an item is goes INSIDE its encrypted metadata (@edit/folders withFolder), written like any edit: the version
// raised (@crypto/metaVersion), sealed with the item key, PUT /api/items/{id}/meta. Every other field stays as it is.
// The server sees only that an item's metadata changed, never which folder it is in.
import { b64, getSodium } from "@crypto/sodium";
import { encryptMeta } from "@crypto/item";
import { nextVersion } from "@crypto/metaVersion";
import { folderOf, withFolder, type Folder } from "@edit/folders";
import { api } from "./api";
import { forgetPictures, type Item } from "./library";
import { session } from "./session";
import { t } from "./i18n";

export type { Folder };

/** Whether the person may move items here (the public demo refuses changes, like editing). */
export const canMove = () => !session().me?.demo;

/** Whether this item can be moved at all: decrypted, with its key, not stale (its metadata is older than one seen
 *  before: writing it would bring back what changed since), not in the trash. */
export const movable = (it: Item) => !it.broken && !it.stale && !it.trashed_at && !!it.itemKey && !!it.meta;

export interface Moved { moved: string[]; failed: number }

/**
 * Moves items into `to`, one PUT per item, a few at a time; `onProgress` counts them. What is there already counts as
 * moved; what can't be moved (or whose PUT fails) counts as failed, and the rest go on. Moving into the locked folder
 * also deletes what this phone keeps of the item (its cached encrypted thumbnail and preview, the native bitmap).
 * The caller reloads the library afterwards.
 */
export async function moveTo(items: Item[], to: Folder, onProgress?: (done: number, total: number) => void): Promise<Moved> {
  if (!canMove()) throw new Error(t("This is the public demo: changes are turned off."));
  const master = session().masterKey;
  if (!master) throw new Error(t("Unlock your library first."));
  const s = await getSodium();
  const moved: string[] = [];
  let failed = 0, done = 0;
  const queue = [...items];
  const one = async (it: Item) => {
    if (!movable(it)) { failed++; return; }
    if (folderOf(it.meta) === to) { moved.push(it.id); return; }
    if (session().masterKey !== master) throw new Error(t("Unlock your library first.")); // locked meanwhile
    const meta = nextVersion(withFolder(it.meta!, to));
    try {
      await api("PUT", `/api/items/${it.id}/meta`, { meta_enc: b64(s, encryptMeta(s, meta, it.itemKey!, it.id)) });
      moved.push(it.id);
      if (to === "locked") forgetPictures(it.id);
    } catch {
      failed++;
    }
  };
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      await one(it);
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  return { moved, failed };
}
