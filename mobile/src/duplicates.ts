// Duplicates and similar photos on the phone (app/duplicates.tsx): the grouping is the web app's
// (web/src/cleanup/duplicates.ts, shared as @cleanup); the vectors stay in the native search index, which only says
// which items have one and scores the pairs it is asked about.
import { findGroups, type Candidate, type Found } from "@cleanup/duplicates";
import type { Item } from "./library";

/** What the grouping needs of an item. Broken items (and the trash, which isn't in the library list) are left out. */
export const candidateOf = (it: Item): Candidate | null =>
  it.broken || !it.meta || it.trashed_at ? null : {
    id: it.id, ts: it.meta.capture_ts, name: it.meta.name, size: it.meta.size || it.size, width: it.meta.width, height: it.meta.height,
    gps: !!it.meta.gps, uploaded: it.created_at, image: it.kind === "image", ...(it.meta.sha256 ? { sha256: it.meta.sha256 } : {}),
  };

export interface Index {
  /** search is ready on this phone (its index is open) */
  ready: boolean;
  indexedAmong: (ids: string[]) => Promise<Set<string>>;
  pairScores: (a: string[], b: string[]) => Promise<ArrayLike<number>>;
}

/** Exact duplicates always; similar photos where the search index is open. */
export async function findDuplicates(items: Item[], index: Index): Promise<Found & { searchOn: boolean }> {
  const cands = items.flatMap((it) => candidateOf(it) ?? []);
  const has = index.ready ? await index.indexedAmong(cands.filter((c) => c.image).map((c) => c.id)) : new Set<string>();
  const found = await findGroups(cands, (id) => has.has(id), index.ready ? index.pairScores : null);
  return { ...found, searchOn: index.ready };
}
