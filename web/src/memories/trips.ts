// Trips: photos taken far from home on consecutive days, offered as suggested albums. Worked out on the device from
// the decrypted capture dates and coordinates; nothing about it goes to the server unless the person saves a trip as
// an album (then it is an ordinary encrypted album). Shared by the web app and the Android app (mobile: the @memories
// alias); the Mac app has the same rules in Trips.swift. Both are checked against the same fixture
// (testdata/trips.json), so a change here needs the same change there.
//
// Days are the capture time's local calendar day, the same day the timeline puts a photo under.

/** A photo counts as away when it was taken farther than this from home. */
export const TRIP_MIN_KM = 80;
/** At most this many days without any photo may fall inside a trip (a day spent on the beach without the phone). */
export const TRIP_MAX_GAP_DAYS = 1;
/** A trip has at least this many photos taken away... */
export const TRIP_MIN_ITEMS = 5;
/** ...on at least this many different days (a day out is not a trip). */
export const TRIP_MIN_DAYS = 2;
/** Home is looked for in cells of this many degrees (about 25 km). */
export const HOME_CELL_DEG = 0.25;
/** A year with photos on at least this many days has a home of its own (people move); others use the whole library's. */
export const HOME_YEAR_MIN_DAYS = 30;

/** What the trips read of an item: both apps' Item types fit. */
export interface TripItem {
  id: string;
  kind: string;
  created_at: number;
  broken?: boolean;
  trashed_at?: number;
  /** `locked: true` is the locked folder (edit/folders.ts): never part of a trip or recap; archived items are */
  meta?: { capture_ts?: number; gps?: { lat: number; lon: number }; locked?: unknown };
}

/** A place lookup's answer (places.ts nearest(), Places.swift on the Mac). */
export interface PlaceHit { place?: { name: string; region: string }; country?: string; countryCode?: string }
export type Lookup = (lat: number, lon: number) => PlaceHit | null | undefined;

/** Where a trip was: one place, one region, one country or several countries (most photos first). */
export type Where =
  | { kind: "place"; name: string; country: string; countryCode: string }
  | { kind: "region"; name: string; country: string; countryCode: string }
  | { kind: "country"; country: string; countryCode: string }
  | { kind: "countries"; countries: { country: string; countryCode: string }[] }
  | { kind: "none" };

export interface Trip<T> {
  /** stable while the trip's first photo stays: "trip-<first day>-<first id>" */
  key: string;
  /** the photos, oldest first: those taken away, and those without a location taken between the first and the last */
  items: T[];
  /** capture times (ms) of the first and the last photo taken away */
  start: number;
  end: number;
  /** different days with photos taken away */
  days: number;
  where: Where;
  /** the home the trip was measured from */
  home: { lat: number; lon: number };
}

export const captured = (it: { created_at: number; meta?: { capture_ts?: number } }): number =>
  (Number.isFinite(it.meta?.capture_ts) ? it.meta!.capture_ts! : it.created_at * 1000);

/** Counts at all: not trashed, not broken, not in the locked folder, a photo or a video with its metadata. */
export const counts = (it: TripItem): boolean =>
  !it.broken && !it.trashed_at && it.meta?.locked !== true && !!it.meta && (it.kind === "image" || it.kind === "video");

/** Coordinates a camera really wrote: in range, and not exactly 0,0 (what broken GPS writes). */
export function gpsOf(it: TripItem): { lat: number; lon: number } | null {
  const g = it.meta?.gps;
  if (!g || typeof g.lat !== "number" || typeof g.lon !== "number") return null;
  const { lat, lon } = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** The local calendar day as a whole number (days since 1970), so a difference is in days whatever the DST. */
export function dayOf(ts: number): number {
  const d = new Date(ts);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** Great-circle distance in km (the same as places.ts). */
export function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Pt { lat: number; lon: number; day: number }

/**
 * Home: the cell of HOME_CELL_DEG degrees with photos on the most different days (not the most photos, so a busy
 * holiday doesn't win), then the most photos, then the lower cell; its photos' median coordinates. Null without any.
 */
export function homeOf(points: Pt[]): { lat: number; lon: number } | null {
  if (!points.length) return null;
  const cells = new Map<string, { days: Set<number>; pts: Pt[]; la: number; lo: number }>();
  for (const p of points) {
    const la = Math.floor(p.lat / HOME_CELL_DEG), lo = Math.floor(p.lon / HOME_CELL_DEG);
    const k = `${la},${lo}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { days: new Set(), pts: [], la, lo }));
    c.days.add(p.day);
    c.pts.push(p);
  }
  let best: { days: Set<number>; pts: Pt[]; la: number; lo: number } | undefined;
  for (const c of cells.values()) {
    if (!best || c.days.size > best.days.size || (c.days.size === best.days.size && (c.pts.length > best.pts.length ||
      (c.pts.length === best.pts.length && (c.la < best.la || (c.la === best.la && c.lo < best.lo)))))) best = c;
  }
  return { lat: median(best!.pts.map((p) => p.lat)), lon: median(best!.pts.map((p) => p.lon)) };
}

/** What a trip's photos have in common: the place holding at least half of those with a known place, else such a
 *  region, else their country, else their countries (most photos first, then by name). */
export function whereOf(hits: (PlaceHit | null | undefined)[]): Where {
  const places = new Map<string, { n: number; name: string; country: string; code: string }>();
  const regions = new Map<string, { n: number; name: string; country: string; code: string }>();
  const countries = new Map<string, { n: number; country: string }>();
  let total = 0;
  for (const h of hits) {
    if (!h || !h.countryCode) continue;
    total++;
    const code = h.countryCode, country = h.country ?? code;
    const c = countries.get(code) ?? { n: 0, country };
    c.n++; countries.set(code, c);
    if (h.place) {
      const pk = `${h.place.name}\u0000${code}`;
      const p = places.get(pk) ?? { n: 0, name: h.place.name, country, code };
      p.n++; places.set(pk, p);
      if (h.place.region) {
        const rk = `${h.place.region}\u0000${code}`;
        const r = regions.get(rk) ?? { n: 0, name: h.place.region, country, code };
        r.n++; regions.set(rk, r);
      }
    }
  }
  if (!total) return { kind: "none" };
  const top = <V extends { n: number }>(m: Map<string, V>, name: (v: V) => string): V | undefined =>
    [...m.values()].sort((a, b) => b.n - a.n || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))[0];
  const p = top(places, (v) => v.name);
  if (p && p.n * 2 >= total) return { kind: "place", name: p.name, country: p.country, countryCode: p.code };
  const r = top(regions, (v) => v.name);
  if (r && r.n * 2 >= total) return { kind: "region", name: r.name, country: r.country, countryCode: r.code };
  const cs = [...countries.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (cs.length === 1) return { kind: "country", country: cs[0][1].country, countryCode: cs[0][0] };
  return { kind: "countries", countries: cs.map(([code, v]) => ({ country: v.country, countryCode: code })) };
}

/**
 * The trips in a library, newest first. Home is worked out per year (HOME_YEAR_MIN_DAYS), else from the whole
 * library. A photo farther than TRIP_MIN_KM from home is away; away photos on days at most TRIP_MAX_GAP_DAYS apart
 * make one trip, until a day with photos only at home. Photos without a location taken during a trip belong to it.
 * `lookup` names the places (none: every trip's `where` is "none").
 */
export function findTrips<T extends TripItem>(items: readonly T[], lookup?: Lookup, opts: { minKm?: number } = {}): Trip<T>[] {
  const minKm = opts.minKm ?? TRIP_MIN_KM;
  const all: { it: T; ts: number; day: number; g: { lat: number; lon: number } | null }[] = [];
  for (const it of items) {
    if (!counts(it)) continue;
    const ts = captured(it);
    if (!Number.isFinite(ts)) continue;
    all.push({ it, ts, day: dayOf(ts), g: gpsOf(it) });
  }
  all.sort((a, b) => a.ts - b.ts || (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0));
  const located = all.filter((x) => x.g);
  const overall = homeOf(located.map((x) => ({ ...x.g!, day: x.day })));
  if (!overall) return [];
  // each year's own home when it has enough days to tell
  const byYear = new Map<number, Pt[]>();
  for (const x of located) {
    const y = new Date(x.ts).getFullYear();
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push({ ...x.g!, day: x.day });
  }
  const homes = new Map<number, { lat: number; lon: number }>();
  for (const [y, pts] of byYear) homes.set(y, new Set(pts.map((p) => p.day)).size >= HOME_YEAR_MIN_DAYS ? homeOf(pts)! : overall);

  // each day with located photos: what was taken away and whether anything was taken at home
  type Day = { day: number; away: typeof located; home: boolean; homeAt: { lat: number; lon: number } };
  const days: Day[] = [];
  for (const x of located) {
    const homeAt = homes.get(new Date(x.ts).getFullYear()) ?? overall;
    let d = days[days.length - 1];
    if (!d || d.day !== x.day) days.push((d = { day: x.day, away: [], home: false, homeAt }));
    if (km(x.g!.lat, x.g!.lon, homeAt.lat, homeAt.lon) > minKm) d.away.push(x); else d.home = true;
  }
  // runs of days away; a day with photos only at home ends one
  const runs: Day[][] = [];
  let cur: Day[] | null = null;
  for (const d of days) {
    if (!d.away.length) { cur = null; continue; }
    if (cur && d.day - cur[cur.length - 1].day <= 1 + TRIP_MAX_GAP_DAYS) cur.push(d);
    else runs.push((cur = [d]));
    // a mixed day (leaving or coming back) stays in the trip, but nothing after it joins
    if (d.home && cur.length > 1) cur = null;
  }

  const trips: Trip<T>[] = [];
  for (const run of runs) {
    const away = run.flatMap((d) => d.away);
    if (away.length < TRIP_MIN_ITEMS || run.length < TRIP_MIN_DAYS) continue;
    const start = away[0].ts, end = away[away.length - 1].ts;
    const ids = new Set(away.map((x) => x.it.id));
    const list = all.filter((x) => ids.has(x.it.id) || (!x.g && x.ts >= start && x.ts <= end));
    trips.push({
      key: `trip-${run[0].day}-${away[0].it.id}`,
      items: list.map((x) => x.it),
      start, end,
      days: run.length,
      where: lookup ? whereOf(away.map((x) => lookup(x.g!.lat, x.g!.lon))) : { kind: "none" },
      home: run[0].homeAt,
    });
  }
  return trips.sort((a, b) => b.start - a.start);
}

/** How a trip's months read: "May 2026", "May – June 2026", "December 2025 – January 2026". `month(ts)` gives the
 *  month's name, `monthYear(ts)` the month with its year, both in the app's language. */
export function tripDates(start: number, end: number, month: (ts: number) => string, monthYear: (ts: number) => string): string {
  const a = new Date(start), b = new Date(end);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return monthYear(start);
  if (a.getFullYear() === b.getFullYear()) return `${month(start)} – ${monthYear(end)}`;
  return `${monthYear(start)} – ${monthYear(end)}`;
}

/** Where, in words: the place, region or country, "Italy and France", "Italy, France and 2 more". `and` and `more`
 *  are the app's words ("and"/"und"; "{n} more"/"{n} weitere"). */
export function whereText(w: Where, and = "and", more = (n: number) => `${n} more`): string {
  switch (w.kind) {
    case "place": case "region": return w.name;
    case "country": return w.country;
    case "countries": {
      const c = w.countries.map((x) => x.country);
      return c.length === 2 ? `${c[0]} ${and} ${c[1]}` : `${c[0]}, ${c[1]} ${and} ${more(c.length - 2)}`;
    }
    default: return "";
  }
}

/** Whether an album already holds this trip (at least 80% of its photos): then it is shown as saved. */
export function savedAs<A extends { itemIds: string[] }>(trip: { items: { id: string }[] }, albums: readonly A[]): A | undefined {
  const ids = trip.items.map((i) => i.id);
  return albums.find((a) => {
    const has = new Set(a.itemIds);
    return ids.filter((id) => has.has(id)).length * 5 >= ids.length * 4;
  });
}
