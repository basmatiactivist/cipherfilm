// Place names on the phone (docs/MAP.md): the GeoNames file shared with the web app (web/src/places), bundled as an
// asset and read once when the map, a photo's details or a search needs it. A photo's coordinates never leave the phone.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { fold, label, Places, summary, type Place } from "@places/places";
import { locale, t } from "./i18n";
import type { Item } from "./library";

export { label, type Place };

type Hit = ReturnType<Places["nearest"]>;

// The place file names countries in English; the app shows them in its own language (Android's translations,
// once per language). In English, or when that fails, the file's names stay.
let names: { lang: string; map: Record<string, string> } | null = null;
function countryNames(p: Places): Record<string, string> {
  const lang = locale().slice(0, 2);
  if (lang === "en") return {};
  if (names?.lang === lang) return names.map;
  let map: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const N = require("../modules/cf-native/src/CfNativeModule").default as { countryNames(c: string[], l: string): Record<string, string> };
    map = N.countryNames(p.countries.map(([c]) => c), lang) ?? {};
  } catch { /* not on a phone (tests): English */ }
  names = { lang, map };
  return map;
}

/** A place hit with its country in the app's language ("Zürich, Schweiz"). */
function local(p: Places, r: Hit): Hit {
  if (!r || !r.countryCode) return r;
  const name = countryNames(p)[r.countryCode];
  if (!name) return r;
  return { ...r, country: name, place: r.place ? { ...r.place, country: name } : r.place };
}

/** A place hit's name in the app's language ("Luzern, Schweiz"): for the editor's current place. */
export const localLabel = (p: Places, r: Hit): string => label(local(p, r));

/** A place from the search with its country in the app's language. */
export function localPlace(p: Places, pl: Place): Place {
  const name = pl.countryCode ? countryNames(p)[pl.countryCode] : undefined;
  return name ? { ...pl, country: name } : pl;
}

let loading: Promise<Places> | null = null;

export function loadPlaces(): Promise<Places> {
  loading ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const a = Asset.fromModule(require("../../web/src/places/places-v1.bin"));
    await a.downloadAsync();
    const bytes = await new File(a.localUri ?? a.uri).bytes();
    return new Places(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Coordinates a camera really wrote: in range, and not exactly 0,0 (what broken GPS writes). */
export function coords(it: Item): { lat: number; lon: number } | null {
  if (it.broken || it.trashed_at) return null;
  const g = it.meta?.gps;
  if (!g || typeof g.lat !== "number" || typeof g.lon !== "number") return null;
  const { lat, lon } = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** "Zürich, Switzerland" for a photo with coordinates, "" otherwise. */
export async function placeName(it: Item): Promise<string> {
  const c = coords(it);
  if (!c) return "";
  try { const p = await loadPlaces(); return label(local(p, p.nearest(c.lat, c.lon))); } catch { return ""; }
}

// each photo's place words for search (town, region, country as the file names it and in the app's language), folded,
// with the names as shown; worked out once per photo, not on every search
type Words = { folded: string[]; names: string[] };
const wordsOf = new WeakMap<Item, Words | null>();
function placeWords(p: Places, it: Item): Words | null {
  if (wordsOf.has(it)) return wordsOf.get(it) ?? null;
  const c = coords(it);
  const r = c ? p.nearest(c.lat, c.lon) : null;
  const names = r ? [r.place?.name, r.place?.region, local(p, r)?.country, r.country].filter((n): n is string => !!n) : [];
  const w = names.length ? { names, folded: names.map(fold) } : null;
  wordsOf.set(it, w);
  return w;
}

/** A query word against a place name: the whole name or one of its words, or the start of one from 4 letters on
 *  ("zurich", "new york", "schweiz", "switz"); shorter words only whole, so "see" or "car" don't pull in every
 *  "Seefeld" or "Carouge". */
export function nameMatches(name: string, q: string): boolean {
  if (name === q) return true;
  const words = name.split(/[\s\-'’]+/);
  return words.includes(q) || (q.length >= 4 && (name.startsWith(q) || words.some((w) => w.startsWith(q))));
}

/** For search: the photos taken in the place, region or country the words name ("zurich", "Zürich", "switzerland",
 *  "new york"), and that place as found; null when the words name no place. exact: only a place's whole name
 *  ("zurich", not the "new" of "New York"). */
export async function inPlace(items: Item[], words: string, exact = false): Promise<{ ids: Set<string>; name: string } | null> {
  const q = fold(words).trim();
  if (q.length < 3) return null;
  const p = await loadPlaces();
  const ids = new Set<string>();
  let name = "";
  for (const it of items) {
    const w = placeWords(p, it);
    if (!w) continue;
    const i = w.folded.findIndex((n) => (exact ? n === q : nameMatches(n, q)));
    if (i >= 0) { ids.add(it.id); name ||= w.names[i]; }
  }
  return ids.size ? { ids, name } : null;
}

// each photo's place, looked up once (the map's panel gets its title anew after every move)
const placeOf = new WeakMap<Item, ReturnType<Places["nearest"]>>();

/** A title for the photos in the map's panel: their place when all are from one ("Zürich, Switzerland"), else their
 *  countries ("Switzerland"; "France and Switzerland"; "France, Switzerland and 3 more"), else "This area". */
export async function areaTitle(items: Item[]): Promise<string> {
  if (!items.length) return t("This area");
  try {
    const p = await loadPlaces();
    const s = summary(items.map((it) => {
      if (!placeOf.has(it)) { const c = coords(it); placeOf.set(it, c ? local(p, p.nearest(c.lat, c.lon)) : null); }
      return placeOf.get(it) ?? null;
    }));
    const c = s.countries;
    if (s.place) return s.place;
    if (c.length === 0) return t("This area");
    if (c.length === 1) return c[0];
    if (c.length === 2) return t("{a} and {b}", { a: c[0], b: c[1] });
    return t("{a}, {b} and {n} more", { a: c[0], b: c[1], n: String(c.length - 2) });
  } catch {
    return t("This area");
  }
}
