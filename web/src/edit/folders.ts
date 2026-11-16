// Archive and locked folder (docs/EDITING.md, "Archive and locked folder"). Which folder an item is in is written
// INSIDE its encrypted metadata (`archived: true` or `locked: true`, through the same PUT /api/items/{id}/meta and
// metadata version as every other change), so the server never learns which items are archived or locked: it sees
// only that an item's metadata changed. Shared by the web app and the Android app (@edit/folders); the Mac mirrors it
// in mac/Sources/CipherfilmCore/Folders.swift, with tests on the same cases.
//
//   library  the main grid, On this day, search, albums, people, map, duplicates, free up space
//   archive  out of the main grid and On this day; still in search, albums, people, the map and favorites
//   locked   in the locked folder only, behind an extra check each time it opens; nowhere else (not even albums:
//            the album keeps the item, its views just don't show it, so moving it back out restores it there)

export type Folder = "library" | "archive" | "locked";

type Flagged = { archived?: unknown; locked?: unknown } | null | undefined;
type Listed = { meta?: Flagged; broken?: boolean; stale?: boolean };

/** Only `true` counts: anything else a device reads (a string, a number) is "not set", never a guess. */
export const isLocked = (meta: Flagged): boolean => meta?.locked === true;
/** Archived and not locked (locked wins if both were ever written). */
export const isArchived = (meta: Flagged): boolean => meta?.archived === true && !isLocked(meta);

/** Handled as a locked item: in the locked folder, or stale (its metadata is an older copy than this device has seen,
 *  crypto/metaVersion.ts, so which folder it is really in isn't known). No open view shows it, nothing of it is kept
 *  on disk and nothing writes its metadata, until a copy at least as new as the one seen arrives. */
export const asLocked = (it: { meta?: Flagged; stale?: boolean }): boolean => it.stale === true || isLocked(it.meta);

export function folderOf(meta: Flagged): Folder {
  return isLocked(meta) ? "locked" : isArchived(meta) ? "archive" : "library";
}

/** Drops flag values that aren't `true` (after decrypting, like normEdit): the rest of the app reads clean metadata. */
export function normFolders<T extends object>(meta: T): T {
  const m = meta as T & { archived?: unknown; locked?: unknown };
  if (m.archived !== undefined && m.archived !== true) delete m.archived;
  if (m.locked !== undefined && m.locked !== true) delete m.locked;
  return meta;
}

/** The metadata with the item moved to `to`: a copy; every other field (also ones this app doesn't know) is kept.
 *  The caller raises the version (nextVersion) and encrypts it as for any other change. */
export function withFolder<T extends object>(meta: T, to: Folder): T {
  const m = { ...meta } as T & { archived?: boolean; locked?: boolean };
  delete m.archived;
  delete m.locked;
  if (to === "archive") m.archived = true;
  if (to === "locked") m.locked = true;
  return m;
}

/** Splits a decrypted list: `open` is everything any view outside the locked folder may show (an unreadable item
 *  can't say where it is and stays with the library, shown as "couldn't be verified" as before), `locked` the rest,
 *  with the stale items (asLocked). Every app splits right after decrypting, so no other view is ever handed one. */
export function splitLocked<T extends Listed>(items: readonly T[]): { open: T[]; locked: T[] } {
  const open: T[] = [], locked: T[] = [];
  for (const it of items) (!it.broken && asLocked(it) ? locked : open).push(it);
  return { open, locked };
}

/** What the main grid and On this day show: neither archived nor locked. */
export const inMainGrid = (it: Listed): boolean => it.broken || folderOf(it.meta) === "library";
export const mainGrid = <T extends Listed>(items: readonly T[]): T[] => items.filter(inMainGrid);
/** The archive view: archived, not locked. */
export const archived = <T extends Listed>(items: readonly T[]): T[] => items.filter((it) => !it.broken && isArchived(it.meta));
