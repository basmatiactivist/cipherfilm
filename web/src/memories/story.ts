// The year in review as a story: the recap (recap.ts) as a list of full-screen slides, played one after the other.
// Pure, so the order is tested (story.test.ts); the player is memories/storyplayer.tsx. The Android and Mac apps
// build the same list.
import type { Recap, RecapItem } from "./recap";

/** How long a slide shows, and each photo of a month with several. */
export const SLIDE_MS = 5000;
export const PHOTO_MS = 1500;
/** Trips in one story at most: the longest. */
export const STORY_TRIPS = 3;

export interface StoryTrip<T> { key: string; start: number; end: number; items: readonly T[] }

export type Slide<T> =
  | { kind: "cover"; item: T }
  | { kind: "month"; month: number; total: number; photos: T[] }
  | { kind: "trip"; key: string; item: T; count: number }
  | { kind: "places"; item: T; name: string; country: string; others: string[] }
  | { kind: "people"; people: { key: string; count: number }[] }
  | { kind: "end" };

const shown = (i: RecapItem & { broken?: boolean }) => !i.broken && i.has_thumb !== false;

/** A month's photos for its slide: the best first (the first favorite, else the middle one), then the others in order. */
export function bestFirst<T extends RecapItem & { broken?: boolean }>(highlights: readonly T[]): T[] {
  const h = highlights.filter(shown);
  if (!h.length) return [];
  const fav = h.findIndex((i) => i.favorite);
  const best = fav >= 0 ? fav : Math.floor((h.length - 1) / 2);
  return [h[best], ...h.filter((_, j) => j !== best)];
}

/** A trip's picture: its first photo with a thumbnail, else its first item with one. */
function tripPicture<T extends RecapItem & { broken?: boolean }>(items: readonly T[]): T | undefined {
  return items.find((i) => shown(i) && i.kind === "image") ?? items.find(shown);
}

/**
 * The slides of a year's story, in order: the cover, each month with photos (and after the month a trip starts in,
 * that trip; at most STORY_TRIPS trips, the ones with most items), the places, the named people, the end.
 * `trips` are the library's (those starting or ending in the year are used); `named` the face groups with a name
 * that aren't hidden.
 */
export function storySlides<T extends RecapItem & { broken?: boolean }>(r: Recap<T>, opts: { trips?: readonly StoryTrip<T>[]; named?: ReadonlySet<string> } = {}): Slide<T>[] {
  const slides: Slide<T>[] = [{ kind: "cover", item: r.cover }];

  const yearOf = (ts: number) => new Date(ts).getFullYear();
  const trips = (opts.trips ?? [])
    .filter((t) => yearOf(t.start) === r.year || yearOf(t.end) === r.year)
    .map((t) => ({ t, item: tripPicture(t.items) }))
    .filter((x): x is { t: StoryTrip<T>; item: T } => !!x.item)
    .sort((a, b) => b.t.items.length - a.t.items.length || a.t.start - b.t.start || (a.t.key < b.t.key ? -1 : 1))
    .slice(0, STORY_TRIPS)
    // in the story: after the month it starts in (one from the year before: before the first month)
    .map((x) => ({ ...x, month: yearOf(x.t.start) < r.year ? -1 : new Date(x.t.start).getMonth() }))
    .sort((a, b) => a.t.start - b.t.start || (a.t.key < b.t.key ? -1 : 1));
  const tripSlide = (x: (typeof trips)[number]): Slide<T> => ({ kind: "trip", key: x.t.key, item: x.item, count: x.t.items.length });

  let next = 0;
  for (const m of r.months) {
    // a trip whose month has no slide of its own comes before the next month
    while (next < trips.length && trips[next].month < m.month) slides.push(tripSlide(trips[next++]));
    const photos = bestFirst(m.highlights);
    if (photos.length) slides.push({ kind: "month", month: m.month, total: m.total, photos });
    while (next < trips.length && trips[next].month === m.month) slides.push(tripSlide(trips[next++]));
  }
  while (next < trips.length) slides.push(tripSlide(trips[next++]));

  const [top, ...rest] = r.places;
  if (top && shown(top.cover)) slides.push({ kind: "places", item: top.cover, name: top.name, country: top.country, others: rest.map((p) => p.name) });

  const people = opts.named ? r.people.filter((p) => opts.named!.has(p.key)) : [];
  if (people.length) slides.push({ kind: "people", people });

  slides.push({ kind: "end" });
  return slides;
}

/** How long a slide shows: a month with several photos PHOTO_MS each, at least SLIDE_MS. */
export const slideMs = (s: Slide<unknown>): number => (s.kind === "month" ? Math.max(SLIDE_MS, PHOTO_MS * s.photos.length) : SLIDE_MS);

/** The photos a slide shows, in order (none on a dark slide). */
export const photosOf = <T>(s: Slide<T>): T[] => (s.kind === "month" ? s.photos : s.kind === "cover" || s.kind === "trip" || s.kind === "places" ? [s.item] : []);
