// One search box for everything the phone knows about a photo: people by name, what is in it (CLIP), file
// names, dates ("2023", "july 2021", "christmas"), cameras, videos and favorites. All of it runs on the decrypted
// library in memory; nothing is sent anywhere.
import { when, type Item } from "../library";
import { textSearch } from "./engine";
import { peopleGroups, type Group } from "./people";
import { locale, t } from "../i18n";
import { inPlace } from "../places";

export interface Result { items: Item[]; people: Group[]; how: string[] }

const MONTHS: Record<string, number> = {};
["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].forEach((m, i) => { MONTHS[m] = i; MONTHS[m.slice(0, 3)] = i; });
["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"].forEach((m, i) => { MONTHS[m] = i; MONTHS[m.slice(0, 3)] = i; });
MONTHS["jänner"] = 0; MONTHS["maerz"] = 2; MONTHS["sept"] = 8;

/** A date in the query: a year, a month, or both; also "christmas" and "weihnachten". */
export function parseDate(q: string): { year?: number; month?: number; day?: number; rest: string } {
  let rest = q.toLowerCase();
  let year: number | undefined, month: number | undefined, day: number | undefined;
  const y = /\b(19[5-9]\d|20[0-9]\d)\b/.exec(rest);
  if (y) { year = +y[1]; rest = rest.replace(y[0], " "); }
  for (const [name, m] of Object.entries(MONTHS).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(^|\\s)${name}\\.?(\\s|$)`);
    if (re.test(rest)) { month = m; rest = rest.replace(re, " "); break; }
  }
  if (/\b(christmas|weihnachten|xmas)\b/.test(rest)) { month = 11; day = -1; }
  return { year, month, day, rest: rest.replace(/\s+/g, " ").trim() };
}

const isVideoWord = (w: string) => /^(videos?|filme?|clips?)$/.test(w);
const isFavWord = (w: string) => /^(favou?rites?|favoriten?|liked|herz)$/.test(w);
const isShotWord = (w: string) => /^(screenshots?|bildschirmfotos?)$/.test(w);
export async function search(qRaw: string, library: Item[]): Promise<Result> {
  const q = qRaw.trim();
  if (!q) return { items: [], people: [], how: [] };
  const how: string[] = [];
  const lower = q.toLowerCase();
  let pool = library.filter((i) => !i.broken);

  // people whose name matches narrow the pool to their photos
  const groups = await peopleGroups().catch(() => [] as Group[]);
  const people = groups.filter((g) => g.person?.name && !g.person.hidden && g.person.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(lower) || lower.split(/\s+/).includes(w)));
  let words = lower.split(/\s+/);
  if (people.length) {
    const ids = new Set(people.flatMap((g) => g.items));
    pool = pool.filter((i) => ids.has(i.id));
    const names = new Set(people.flatMap((g) => g.person!.name.toLowerCase().split(/\s+/)));
    words = words.filter((w) => !names.has(w) && !people.some((g) => g.person!.name.toLowerCase().startsWith(w)));
    how.push(people.map((g) => g.person!.name).join(", "));
  }

  // kinds
  if (words.some(isVideoWord)) { pool = pool.filter((i) => i.kind === "video"); words = words.filter((w) => !isVideoWord(w)); how.push(t("videos")); }
  if (words.some(isFavWord)) { pool = pool.filter((i) => i.favorite); words = words.filter((w) => !isFavWord(w)); how.push(t("favorites")); }
  if (words.some(isShotWord)) { pool = pool.filter((i) => /screenshot|bildschirm/i.test(i.meta?.name ?? "")); words = words.filter((w) => !isShotWord(w)); how.push(t("screenshots")); }

  // dates
  const d = parseDate(words.join(" "));
  if (d.year !== undefined || d.month !== undefined) {
    pool = pool.filter((i) => {
      const at = new Date(when(i));
      if (d.year !== undefined && at.getFullYear() !== d.year) return false;
      if (d.month !== undefined && at.getMonth() !== d.month) return false;
      if (d.day === -1 && (at.getDate() < 20 || at.getDate() > 27)) return false;
      return true;
    });
    how.push([d.month !== undefined ? new Intl.DateTimeFormat(locale(), { month: "long" }).format(new Date(2000, d.month, 1)) : "", d.year ?? ""].join(" ").trim());
  }
  let rest = d.rest;
  if (!rest) return { items: sortByDate(pool), people, how };

  // places, from each photo's coordinates on this phone (places.ts). With more words, one that is exactly a place
  // narrows the rest to it ("zurich beach": the photos from Zurich that show a beach)
  const placed0 = rest.includes(" ") ? await inPlace(pool, rest).catch(() => null) : null;
  if (rest.includes(" ") && !placed0) {
    for (const w of rest.split(/\s+/)) {
      const r = await inPlace(pool, w, true).catch(() => null);
      if (!r || r.ids.size === pool.length) continue;
      pool = pool.filter((i) => r.ids.has(i.id));
      how.push(r.name);
      rest = rest.split(/\s+/).filter((x) => x !== w).join(" ");
    }
    if (!rest) return { items: sortByDate(pool), people, how };
  }
  // what is left may name a place too: those photos come first, then the rest of the search (not instead of it,
  // so "see" or "berg" still find lakes and mountains)
  const placed = await inPlace(pool, rest).catch(() => null);

  // file names and cameras: exact substring matches first
  const named = pool.filter((i) => (i.meta?.name ?? "").toLowerCase().includes(rest) || `${i.meta?.make ?? ""} ${i.meta?.model ?? ""}`.toLowerCase().includes(rest));

  // what is in the photo
  const hits = await textSearch(rest).catch(() => []);
  const inPool = new Map(pool.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const i of named) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
  if (placed) {
    for (const i of sortByDate(pool.filter((x) => placed.ids.has(x.id)))) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
    how.push(placed.name);
  }
  for (const h of hits) { const it = inPool.get(h.id); if (it && !seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  if (hits.length) how.push(t('"{q}"', { q: rest }));
  else if (named.length) how.push(t('named "{q}"', { q: rest }));
  return { items: out, people, how };
}

export const sortByDate = (list: Item[]) => [...list].sort((a, b) => when(b) - when(a));

/** Ideas shown under an empty search box: everyday things the model knows well. */
export const SUGGESTIONS = ["beach", "mountains", "snow", "sunset", "food", "dog", "cat", "car", "birthday cake", "flowers", "city at night", "document", "selfie", "forest", "lake"];
