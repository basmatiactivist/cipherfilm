// The year in review as a story (app/recap/story/[year].tsx): the recap's parts as slides, one after the other.
// The same order as the web and Mac apps: the cover, each month (a trip right after the month it starts in), the
// places, the people, the end.
import type { Recap, RecapItem } from "@memories/recap";

/** Trips shown in a story: the longest ones, by item count. */
export const STORY_TRIPS = 3;
/** How long a slide stays, and a month's photos each (a month with several stays longer), in ms. */
export const SLIDE_MS = 5000;
export const PHOTO_MS = 1500;

export interface StoryTrip<T> { key: string; title: string; start: number; items: T[] }

export type Slide<T> =
  | { kind: "cover"; item: T }
  | { kind: "month"; month: number; total: number; photos: T[] }
  | { kind: "trip"; key: string; title: string; count: number; item: T }
  | { kind: "places"; item: T; top: { name: string; country: string }; others: string[] }
  | { kind: "people"; people: { key: string; count: number }[] }
  | { kind: "end" };

/** A month's photos for its slide: the best first (the first favorite, else the middle one), then the others in their
 *  order. The same pick as the web and Mac apps. */
function monthPhotos<T extends RecapItem>(highlights: T[]): T[] {
  const fav = highlights.findIndex((i) => i.favorite);
  const best = fav >= 0 ? fav : Math.floor((highlights.length - 1) / 2);
  if (best <= 0) return highlights;
  return [highlights[best], ...highlights.slice(0, best), ...highlights.slice(best + 1)];
}

/** The slides of a recap. trips: the year's trips; people: the recap's people that have a name (and aren't hidden). */
export function storySlides<T extends RecapItem>(r: Recap<T>, trips: StoryTrip<T>[], namedPeople: Set<string>): Slide<T>[] {
  const out: Slide<T>[] = [{ kind: "cover", item: r.cover }];
  const kept = [...trips].filter((x) => x.items.length).sort((a, b) => b.items.length - a.items.length || a.start - b.start).slice(0, STORY_TRIPS);
  const byMonth = new Map<number, StoryTrip<T>[]>();
  for (const x of kept) {
    const d = new Date(x.start);
    // a trip that started the year before comes after January
    const m = d.getFullYear() < r.year ? 0 : d.getMonth();
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(x);
  }
  const placed = new Set<string>();
  for (const m of r.months) {
    if (m.highlights.length) out.push({ kind: "month", month: m.month, total: m.total, photos: monthPhotos(m.highlights) });
    for (const x of (byMonth.get(m.month) ?? []).sort((a, b) => a.start - b.start)) {
      out.push({ kind: "trip", key: x.key, title: x.title, count: x.items.length, item: x.items[0] });
      placed.add(x.key);
    }
  }
  // a trip whose month has no photos of the year (it began the year before and the year's first month is quiet)
  for (const x of kept) if (!placed.has(x.key)) out.push({ kind: "trip", key: x.key, title: x.title, count: x.items.length, item: x.items[0] });
  if (r.places.length) {
    const [top, ...rest] = r.places;
    out.push({ kind: "places", item: top.cover, top: { name: top.name, country: top.country }, others: rest.map((p) => p.name) });
  }
  const people = r.people.filter((p) => namedPeople.has(p.key));
  if (people.length) out.push({ kind: "people", people });
  out.push({ kind: "end" });
  return out;
}

/** How long a slide stays. */
export function slideMs(s: Slide<unknown>): number {
  return s.kind === "month" ? Math.max(SLIDE_MS, s.photos.length * PHOTO_MS) : SLIDE_MS;
}

/** The items a slide shows, for loading their pictures ahead. */
export function slideItems<T>(s: Slide<T>): T[] {
  switch (s.kind) {
    case "cover": case "trip": case "places": return [s.item];
    case "month": return s.photos;
    default: return [];
  }
}
