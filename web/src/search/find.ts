// Search over a list of items, as the library's search box does it (library.tsx) and as a custom review does it
// (memories/reviews.ts): the filters of the query first, then the words in names, cameras and albums, the text read in
// the photos, and what the photos show (the image model's hits, worked out before), in that order.
import type { Item } from "../items";
import { haystack, matches } from "../search";
import { fold as foldWords, type Parsed } from "./parse";
import { narrow as narrowBy, textHits, type Facts } from "./combined";
import { closeMatches } from "./matches";
import type { Hit } from "./rank";

/** What each item can be found by: its name, date, camera, type, its albums, the people in it and its place. */
export function buildHay(items: readonly Item[], albums: readonly { itemIds: string[]; name: string }[], named: readonly { name: string; items: string[] }[], placeWords: Map<string, string> | null): Map<string, string> {
  const extra = new Map<string, string[]>();
  const add = (id: string, n: string) => extra.set(id, [...(extra.get(id) ?? []), n]);
  for (const [id, w] of placeWords ?? []) add(id, w);
  for (const a of albums) for (const id of a.itemIds) add(id, a.name);
  for (const g of named) for (const id of g.items) add(id, g.name);
  const out = new Map<string, string>();
  for (const it of items) out.set(it.id, foldWords(haystack(it, extra.get(it.id))));
  return out;
}

/** The people and places the filters of a query look at. */
export function buildFacts(named: readonly { name: string; items: string[] }[], byItem: Map<string, string[]> | undefined): Facts {
  const ppl = new Map<string, Set<string>>();
  for (const g of named) ppl.set(g.name, new Set([...(ppl.get(g.name) ?? []), ...g.items]));
  return { people: ppl, places: byItem ?? new Map() };
}

/** The items the search finds in list, in order; close: how many of them are results (the rest are similar photos,
 *  ranked by the image model below its close matches). ranked: the image model's hits, null without. */
export function findIn(list: Item[], parsed: Parsed, facts: Facts, hay: Map<string, string>, textOf: (id: string) => string, ranked: Hit[] | null): { items: Item[]; close: number } {
  const all = (items: Item[]) => ({ items, close: items.length });
  const pool = parsed.chips.length ? narrowBy(list, parsed, facts) : list;
  if (!parsed.text) return all(pool);
  const named = pool.filter((i) => matches(hay.get(i.id) ?? "", parsed.text));
  const seen = new Set(named.map((i) => i.id));
  const out = [...named];
  const byId = new Map(pool.map((i) => [i.id, i]));
  for (const [id] of textHits(pool, parsed.text, textOf)) { const it = byId.get(id); if (it && !seen.has(id)) { seen.add(id); out.push(it); } }
  if (!ranked) return all(out);
  // the cut is worked out among the photos the filters let through: "dog Anna" finds Anna's best dog photos
  const left = ranked.filter((h) => byId.has(h.id) && !seen.has(h.id));
  const close = out.length + closeMatches(left.map((h) => h.score));
  for (const h of left) { seen.add(h.id); out.push(byId.get(h.id)!); }
  return { items: out, close };
}
