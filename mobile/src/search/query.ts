// One search box for everything the phone knows about a photo (docs/SEARCH.md "Combined search"): "dog beach May 2025
// Anna Rome" is the photos of Anna, taken in Rome in May 2025, that show a dog on a beach. The query is split by the
// parser the web app shares (@websearch/parse) into filters (people, dates, places, favorites, videos, screenshots),
// shown as chips under the box, and the words left: matched against file names and cameras, the text in photos, and
// what is in them (the image model). All of it runs on the decrypted library in memory; nothing is sent anywhere.
import { when, type Item } from "../library";
import { textHits, textSearch } from "./engine";
import { peopleGroups, type Group } from "./people";
import { locale, t } from "../i18n";
import { inPlace, placeIndex } from "../places";
import { fold, inWhen, localDay, parse, removeChip, tokens, type Chip, type When } from "@websearch/parse";
import { closeMatches } from "@websearch/matches";

export { removeChip, type Chip };

/** items: what was found (the count says these); similar: the photos the image model ranks below its close matches,
 *  best first ("More similar photos", docs/SEARCH.md "Close matches"); chips: what the query was taken as (with label,
 *  the words shown on it); snippets: for photos found by the text in them, a piece of that text */
export interface Result { items: Item[]; similar: Item[]; people: Group[]; how: string[]; chips: (Chip & { label: string })[]; snippets: Record<string, string> }

export const EMPTY: Result = { items: [], similar: [], people: [], how: [], chips: [], snippets: {} };

export async function search(qRaw: string, library: Item[], today = localDay(Date.now())): Promise<Result> {
  const q = qRaw.trim();
  if (!q) return EMPTY;
  const all = library.filter((i) => !i.broken);
  let pool = all;

  // the account's named people (hidden ones left out) and the places the photos are in: what the parser may take
  const groups = await peopleGroups().catch(() => [] as Group[]);
  const named = groups.filter((g) => g.person?.name && !g.person.hidden);
  const places = await placeIndex(all).catch(() => null);
  const p = parse(q, { people: [...new Set(named.map((g) => g.person!.name))], place: places?.find, today });

  // filters: all must hold; a person chip is any of its names (two Annas: either)
  const byName = new Map<string, Set<string>>();
  for (const g of named) {
    let set = byName.get(g.person!.name);
    if (!set) byName.set(g.person!.name, (set = new Set()));
    for (const id of g.items) set.add(id);
  }
  for (const names of p.people) pool = pool.filter((i) => names.some((n) => byName.get(n)?.has(i.id)));
  for (const w of p.dates) pool = pool.filter((i) => inWhen(w, localDay(when(i))));
  if (places) for (const name of p.places) { const ids = places.ids(name); pool = pool.filter((i) => ids.has(i.id)); }
  if (p.favorites) pool = pool.filter((i) => i.favorite);
  if (p.videos) pool = pool.filter((i) => i.kind === "video");
  if (p.screenshots) pool = pool.filter((i) => /screenshot|bildschirm/i.test(i.meta?.name ?? ""));

  const chosen = new Set(p.people.flat());
  const people = named.filter((g) => chosen.has(g.person!.name));
  const raw = tokens(q);
  const chips = p.chips.map((c) => ({ ...c, label: chipLabel(c, raw) }));
  const rest = p.text;
  if (!rest) return { items: sortByDate(pool), similar: [], people, how: [], chips, snippets: {} };

  const how: string[] = [];
  // file names and cameras: substring matches first
  const named0 = pool.filter((i) => fold(i.meta?.name ?? "").includes(rest) || fold(`${i.meta?.make ?? ""} ${i.meta?.model ?? ""}`).includes(rest));
  // what is left may still name a place loosely ("zuri", "new"): those photos next, then the rest of the search (not
  // instead of it, so "see" or "berg" still find lakes and mountains); only when nothing else narrowed to a place
  const placed = !p.places.length ? await inPlace(pool, rest).catch(() => null) : null;
  // the text in photos, then what is in them
  const inPool = new Map(pool.map((i) => [i.id, i]));
  const read = textHits(inPool.keys(), rest);
  const hits = p.clip ? await textSearch(p.clip).catch(() => []) : [];

  const seen = new Set<string>();
  const out: Item[] = [];
  const add = (i: Item | undefined) => { if (i && !seen.has(i.id)) { seen.add(i.id); out.push(i); } };
  named0.forEach(add);
  if (placed) { sortByDate(pool.filter((x) => placed.ids.has(x.id))).forEach(add); how.push(placed.name); }
  const snippets: Record<string, string> = {};
  for (const r of read) { snippets[r.id] = r.snippet; add(inPool.get(r.id)); }
  // what the image model ranks: the close matches among the photos the filters let through are results, the rest
  // similar photos (@websearch/matches, the same cut as the web and the Mac)
  const ranked = hits.filter((h) => inPool.has(h.id) && !seen.has(h.id));
  const close = closeMatches(ranked.map((h) => h.score));
  for (const h of ranked.slice(0, close)) add(inPool.get(h.id));
  const similar = ranked.slice(close).map((h) => inPool.get(h.id)!);
  if (read.length) how.push(t('text in photos: "{q}"', { q: read[0].snippet }));
  if (close) how.push(t('"{q}"', { q: rest }));
  else if (named0.length) how.push(t('named "{q}"', { q: rest }));
  return { items: out, similar, people, how, chips, snippets };
}

/** What a chip shows: the person's name (or the words typed, for two people of that name), the place, the dates. */
export function chipLabel(c: Chip, raw: string[]): string {
  const typed = raw.slice(c.start, c.end).join(" ");
  switch (c.kind) {
    case "person": return c.names?.length === 1 ? c.names[0] : typed;
    case "place": return c.place ?? typed;
    case "favorites": return t("Favorites");
    case "videos": return t("Videos");
    case "screenshots": return t("Screenshots");
    case "date": return (c.when && whenLabel(c.when)) || typed;
  }
}

const month = (m: number, year?: number) =>
  new Intl.DateTimeFormat(locale(), year === undefined ? { month: "long" } : { month: "long", year: "numeric" }).format(new Date(year ?? 2000, m, 1));
const lastDay = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** A date filter in words: "2025", "2019 – 2021", "May 2025", "May – July 2025", "Christmas 2023", "Since 2020"; ""
 *  when it is none of these (the chip then shows the words typed). */
export function whenLabel(w: When): string {
  const ymd = (d?: string) => (d ? { y: +d.slice(0, 4), m: +d.slice(5, 7) - 1, d: +d.slice(8, 10) } : null);
  const a = ymd(w.from), b = ymd(w.to);
  if (w.months && !a && !b) {
    if (w.days && w.months[0] === 11 && w.months[1] === 11 && w.days[0] === 20 && w.days[1] === 27) return t("Christmas");
    if (w.days) return "";
    return w.months[0] === w.months[1] ? month(w.months[0]) : `${month(w.months[0])} – ${month(w.months[1])}`;
  }
  if (w.months || w.days) return "";
  if (a && b) {
    if (a.m === 0 && a.d === 1 && b.m === 11 && b.d === 31) return a.y === b.y ? String(a.y) : `${a.y} – ${b.y}`;
    if (a.y === b.y && a.m === 11 && a.d === 20 && b.m === 11 && b.d === 27) return t("Christmas {year}", { year: String(a.y) });
    if (a.y === b.y && a.d === 1 && b.d === lastDay(b.y, b.m)) return a.m === b.m ? month(a.m, a.y) : `${month(a.m)} – ${month(b.m, b.y)}`;
    if (w.from === w.to) return new Date(a.y, a.m, a.d).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" });
    return "";
  }
  if (a && !b && a.m === 0 && a.d === 1) return t("Since {year}", { year: String(a.y) });
  if (b && !a && b.m === 11 && b.d === 31) return t("Until {year}", { year: String(b.y) });
  return "";
}

export const sortByDate = (list: Item[]) => [...list].sort((a, b) => when(b) - when(a));

/** Ideas shown under an empty search box: everyday things the model knows well. */
export const SUGGESTIONS = ["beach", "mountains", "snow", "sunset", "food", "dog", "cat", "car", "birthday cake", "flowers", "city at night", "document", "selfie", "forest", "lake"];
