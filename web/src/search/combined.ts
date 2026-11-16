// Combined search on the web (docs/SEARCH.md "Combined search"): the parsed query (parse.ts) narrows the library by
// people, dates, places, favorites, videos and screenshots; the words left are looked for in names, cameras and
// albums, in the text read in the photos, and by what the photos show (ranked by the image model, content.ts).
import type { Item } from "../items";
import { fold, inWhen, localDay, textMatch, type Chip, type Parsed, type When } from "./parse";

export interface Facts {
  /** person name → the items their faces are in */
  people: Map<string, Set<string>>;
  /** item → its place names (town, region, country) */
  places: Map<string, string[]>;
}

const taken = (it: Item) => it.meta?.capture_ts ?? it.created_at * 1000;

/** The items every filter of the query lets through, in the order given. */
export function narrow(list: Item[], p: Parsed, f: Facts): Item[] {
  return list.filter((it) => {
    if (p.favorites && !it.favorite) return false;
    if (p.videos && it.kind !== "video") return false;
    if (p.screenshots && !/screenshot|bildschirm/i.test(it.meta?.name ?? "")) return false;
    for (const names of p.people) if (!names.some((n) => f.people.get(n)?.has(it.id))) return false;
    if (p.places.length) {
      // by the folded name: two places spelled differently can fold alike ("Zürich", "Zurich")
      const here = f.places.get(it.id)?.map(fold);
      if (!here || !p.places.every((x) => here.includes(fold(x)))) return false;
    }
    if (p.dates.length) {
      const day = localDay(taken(it));
      if (!p.dates.every((w) => inWhen(w, day))) return false;
    }
    return true;
  });
}

/** The photos whose read text has all the words, with the piece that matched. */
export function textHits(list: Item[], words: string, textOf: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  if (!words) return out;
  for (const it of list) {
    const m = textMatch(textOf(it.id), words);
    if (m) out.set(it.id, m);
  }
  return out;
}

const MONTH = (m: number) => new Intl.DateTimeFormat("en", { month: "long" }).format(new Date(2000, m, 1));
const day = (s: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));

/** A date filter in words: "2025", "May 2025", "2019–2021", "May–July", "Since 2020", "Christmas 2023". */
export function whenLabel(w: When): string {
  const months = w.months ? (w.months[0] === w.months[1] ? MONTH(w.months[0]) : `${MONTH(w.months[0])}–${MONTH(w.months[1])}`) : "";
  if (w.days && w.months?.[0] === 11 && w.days[0] === 20) return "Christmas";
  if (!w.from && !w.to) return months;
  const [fy, fm, fd] = w.from ? w.from.split("-").map(Number) : [];
  const [ty, tm, td] = w.to ? w.to.split("-").map(Number) : [];
  if (!w.to) return `Since ${fm === 1 && fd === 1 ? fy : day(w.from!)}`;
  if (!w.from) return `Until ${tm === 12 && td === 31 ? ty : day(w.to)}`;
  if (w.from === w.to) return day(w.from);
  if (fm === 12 && fd === 20 && tm === 12 && td === 27 && fy === ty) return `Christmas ${fy}`;
  if (fm === 1 && fd === 1 && tm === 12 && td === 31) return fy === ty ? `${fy}` : `${fy}–${ty}`;
  if (fy === ty && fd === 1) return fm === tm ? `${MONTH(fm - 1)} ${fy}` : `${MONTH(fm - 1)}–${MONTH(tm - 1)} ${fy}`;
  return `${day(w.from)} – ${day(w.to)}`;
}

/** What a chip says. */
export function chipLabel(c: Chip): string {
  switch (c.kind) {
    case "person": return c.names!.join(" or ");
    case "place": return c.place!;
    case "date": return whenLabel(c.when!);
    case "favorites": return "Favorites";
    case "videos": return "Videos";
    case "screenshots": return "Screenshots";
  }
}
