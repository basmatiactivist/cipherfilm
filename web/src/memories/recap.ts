// The year recap: per year, how many photos and videos, the places and people seen most, and a few photos for each
// month. Worked out on the device from the decrypted capture dates, places and faces; nothing about it goes to the
// server. Shared by the web app and the Android app (@memories); the Mac app has the same rules in Recap.swift,
// checked against the same fixture (testdata/trips.json).
import { looksLikeScreenshot, sample } from "./memories";
import { captured, counts, dayOf, gpsOf, type Lookup, type TripItem } from "./trips";

/** Photos shown for each month. */
export const RECAP_PER_MONTH = 4;
/** Places and people listed. */
export const RECAP_TOP = 5;

export interface RecapItem extends TripItem {
  has_thumb?: boolean;
  favorite?: boolean;
  meta?: TripItem["meta"] & { name?: string };
}

export interface Recap<T> {
  year: number;
  photos: number;
  videos: number;
  /** different days with photos */
  days: number;
  /** most photos first: "Zürich" with its country */
  places: { name: string; country: string; countryCode: string; count: number; cover: T }[];
  /** different countries photos were taken in */
  countries: number;
  /** the people (face groups) in most photos of the year, most first */
  people: { key: string; count: number }[];
  /** each month with photos (0 = January), in order */
  months: { month: number; total: number; highlights: T[] }[];
  cover: T;
}

/** The years with a recap: every earlier year with photos, and this year from December on. Newest first. */
export function recapYears(items: readonly RecapItem[], now: Date | number = Date.now()): number[] {
  const today = new Date(now);
  const last = today.getMonth() === 11 ? today.getFullYear() : today.getFullYear() - 1;
  const years = new Set<number>();
  for (const it of items) {
    if (!counts(it)) continue;
    const y = new Date(captured(it)).getFullYear();
    if (Number.isFinite(y) && y <= last) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

const usable = (i: RecapItem) => i.kind === "image" && i.has_thumb !== false && !looksLikeScreenshot(i.meta?.name);

/**
 * A month's highlights, oldest first: favorites first (spread over the month), then one photo from the middle of each
 * day, spread over the days, then (a month of few days) the others, spread too. Images with a thumbnail that aren't screenshots; when a month has none, whatever has a
 * thumbnail.
 */
export function highlights<T extends RecapItem>(list: readonly T[], n = RECAP_PER_MONTH): T[] {
  const sorted = [...list].sort((a, b) => captured(a) - captured(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let pool = sorted.filter(usable);
  if (!pool.length) pool = sorted.filter((i) => i.has_thumb !== false);
  const picks = sample(pool.filter((i) => i.favorite), n);
  const chosen = new Set(picks.map((i) => i.id));
  const byDay = new Map<number, T[]>();
  for (const i of pool) if (!chosen.has(i.id)) { const d = dayOf(captured(i)); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(i); }
  const perDay = [...byDay.values()].map((l) => l[Math.floor((l.length - 1) / 2)]);
  picks.push(...sample(perDay, n - picks.length));
  // a month whose photos are from fewer days than places: the rest of them, spread over the month
  if (picks.length < n) {
    const taken = new Set(picks.map((i) => i.id));
    picks.push(...sample(pool.filter((i) => !taken.has(i.id)), n - picks.length));
  }
  return picks.sort((a, b) => captured(a) - captured(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The recap of one year, or null when it has no photos. `lookup` names the places (none: no places); `people` are
 * the face groups to count (each with its photos' ids), none when faces are off.
 */
export function yearRecap<T extends RecapItem>(items: readonly T[], year: number, opts: { lookup?: Lookup; people?: readonly { key: string; items: readonly string[] }[]; perMonth?: number } = {}): Recap<T> | null {
  const list = items.filter((it) => counts(it) && new Date(captured(it)).getFullYear() === year)
    .sort((a, b) => captured(a) - captured(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!list.length) return null;
  const months = new Map<number, T[]>();
  for (const it of list) { const m = new Date(captured(it)).getMonth(); (months.get(m) ?? months.set(m, []).get(m)!).push(it); }

  const placeCount = new Map<string, { name: string; country: string; countryCode: string; items: T[] }>();
  const countries = new Set<string>();
  if (opts.lookup) {
    for (const it of list) {
      const g = gpsOf(it);
      const h = g ? opts.lookup(g.lat, g.lon) : null;
      if (!h?.countryCode) continue;
      countries.add(h.countryCode);
      if (!h.place) continue;
      const k = `${h.place.name}\u0000${h.countryCode}`;
      const p = placeCount.get(k) ?? { name: h.place.name, country: h.country ?? h.countryCode, countryCode: h.countryCode, items: [] };
      p.items.push(it);
      placeCount.set(k, p);
    }
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const places = [...placeCount.values()]
    .sort((a, b) => b.items.length - a.items.length || byName(a.name, b.name) || byName(a.countryCode, b.countryCode))
    .slice(0, RECAP_TOP)
    .map((p) => ({ name: p.name, country: p.country, countryCode: p.countryCode, count: p.items.length, cover: highlights(p.items, 1)[0] ?? p.items[0] }));

  const ids = new Set(list.map((i) => i.id));
  const people = (opts.people ?? [])
    .map((g) => ({ key: g.key, count: g.items.filter((id) => ids.has(id)).length }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count || byName(a.key, b.key))
    .slice(0, RECAP_TOP);

  const perMonth = opts.perMonth ?? RECAP_PER_MONTH;
  const monthList = [...months.entries()].sort((a, b) => a[0] - b[0]).map(([month, l]) => ({ month, total: l.length, highlights: highlights(l, perMonth) }));
  const favs = list.filter((i) => i.favorite && usable(i));
  return {
    year,
    photos: list.filter((i) => i.kind === "image").length,
    videos: list.filter((i) => i.kind === "video").length,
    days: new Set(list.map((i) => dayOf(captured(i)))).size,
    places,
    countries: countries.size,
    people,
    months: monthList,
    cover: highlights(favs.length ? favs : list, 1)[0] ?? list[0],
  };
}
