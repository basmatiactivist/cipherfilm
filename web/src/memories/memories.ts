// Memories, "On this day": the photos taken around today's date in earlier years, one group per year. Worked out on
// the device from the decrypted capture dates; nothing about it goes to the server. Shared by the web app and the
// Android app (mobile: the @memories alias); the Mac app has the same rules in Memories.swift.
//
// Dates are the capture time's local calendar day, the same day the timeline puts a photo under.

/** How many days before and after today's date a photo may be taken to count (in each earlier year). */
export const MEMORY_WINDOW_DAYS = 3;
/** At most this many photos per year: a big day (a wedding, a trip) is sampled evenly across its time span. */
export const MEMORY_MAX_PER_YEAR = 200;

/** What the selection reads of an item: both apps' Item types fit. */
export interface MemoryItem {
  id: string;
  kind: string;
  created_at: number;
  has_thumb?: boolean;
  broken?: boolean;
  trashed_at?: number;
  meta?: { name?: string; capture_ts?: number };
}

export interface Memory<T> {
  /** the earlier year whose date this is ("3 years ago" = this year minus 3) */
  year: number;
  yearsAgo: number;
  /** the photos, oldest first (sampled when there are more than MEMORY_MAX_PER_YEAR) */
  items: T[];
  /** how many there were before sampling */
  total: number;
  cover: T;
  /** the cover's capture time (ms): its day is what the card says */
  date: number;
}

/** File names that say "screenshot" in the common phone, Mac and Windows spellings. */
const SCREENSHOT = /screenshot|screen[ _-]?shot|bildschirmfoto|screen[ _-]?recording|bildschirmaufnahme|^scr_|^scrn/i;
export const looksLikeScreenshot = (name: string | undefined): boolean => !!name && SCREENSHOT.test(name);

const captured = (it: MemoryItem): number => (Number.isFinite(it.meta?.capture_ts) ? it.meta!.capture_ts! : it.created_at * 1000);

/** A calendar day as a whole number (days since 1970 in UTC terms), so a difference is in days whatever the DST. */
const dayNo = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / 86_400_000);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** Today's month and day in year y: 29 February becomes the 28th in a year without it. */
const anchor = (y: number, m: number, d: number) => dayNo(y, m, Math.min(d, daysIn(y, m)));

/** Evenly spread picks of n out of list, the first and last included. */
export function sample<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  if (n <= 1) return list.slice(0, Math.max(0, n));
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out;
}

/** A photo that stands for the day: an image rather than a video, not a screenshot, with a thumbnail, from the middle
 *  of the day's set. Falls back step by step, so there is always a cover. */
export function pickCover<T extends MemoryItem>(items: T[]): T {
  const tiers = [
    items.filter((i) => i.kind === "image" && i.has_thumb !== false && !looksLikeScreenshot(i.meta?.name)),
    items.filter((i) => i.kind === "image" && i.has_thumb !== false),
    items.filter((i) => i.has_thumb !== false),
    items,
  ];
  const pool = tiers.find((t) => t.length)!;
  return pool[Math.floor((pool.length - 1) / 2)];
}

/**
 * The memories for `now`: for each earlier year with photos within MEMORY_WINDOW_DAYS of today's date in that year,
 * one group, newest year first. Trashed, unreadable and non-media items are left out (as in the timeline). A photo
 * near New Year counts for the year whose date it is close to (30 December 2023 is "1 year ago" on 1 January 2025).
 */
export function findMemories<T extends MemoryItem>(items: readonly T[], now: Date | number = Date.now(), opts: { window?: number; max?: number } = {}): Memory<T>[] {
  const win = opts.window ?? MEMORY_WINDOW_DAYS;
  const max = opts.max ?? MEMORY_MAX_PER_YEAR;
  const today = new Date(now);
  const ty = today.getFullYear(), tm = today.getMonth(), td = today.getDate();
  const byYear = new Map<number, { it: T; ts: number }[]>();
  for (const it of items) {
    if (it.broken || it.trashed_at || !it.meta || (it.kind !== "image" && it.kind !== "video")) continue;
    const ts = captured(it);
    if (!Number.isFinite(ts)) continue;
    const d = new Date(ts);
    const y = d.getFullYear();
    if (!Number.isFinite(y) || y >= ty + 1) continue;
    const day = dayNo(y, d.getMonth(), d.getDate());
    // today's date in the photo's own year and the years either side (a window can cross New Year)
    let best: number | undefined, bestDiff = Infinity;
    for (const ay of [y - 1, y, y + 1]) {
      if (ay >= ty) continue;
      const diff = Math.abs(day - anchor(ay, tm, td));
      if (diff <= win && diff < bestDiff) { best = ay; bestDiff = diff; }
    }
    if (best === undefined) continue;
    (byYear.get(best) ?? byYear.set(best, []).get(best)!).push({ it, ts });
  }
  const out: Memory<T>[] = [];
  for (const [year, list] of byYear) {
    list.sort((a, b) => a.ts - b.ts || (a.it.id < b.it.id ? -1 : 1));
    const all = list.map((x) => x.it);
    const shown = sample(all, max);
    const cover = pickCover(shown);
    out.push({ year, yearsAgo: ty - year, items: shown, total: all.length, cover, date: captured(cover) });
  }
  return out.sort((a, b) => b.year - a.year);
}

/** The local calendar day of `now` as a string: memories are worked out again when it changes. */
export const todayKey = (now: Date | number = Date.now()): string => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
