// Custom reviews: a search the person saved ("dogs", "Anna in Zürich"), played as a story like the year in review, once
// a day, week or month, with different photos each time. Pure, so it's tested (custom.test.ts) and shared: the web app
// and the Android app use it (@memories); the Mac app has the same rules in CustomReview.swift, checked against the
// same fixture (testdata/custom.json). The search itself is each app's own; this only works out when a review is due,
// which of its matches it shows, and the slides.
//
// The reviews live in one document per account, encrypted with the master key (encryptReviews in crypto/search.ts):
// the server stores it and tells the other devices when it changed, and never learns what a review searches for, what
// it's called or which photos it showed (docs/MEMORIES.md "Custom reviews").
import { looksLikeScreenshot } from "./memories";
import { captured } from "./trips";

export type Every = "day" | "week" | "month";
export const EVERY: readonly Every[] = ["day", "week", "month"];
/** How many photos a review can show. */
export const COUNTS = [6, 12, 20, 30] as const;
export const MAX_REVIEWS = 20;
/** Photos remembered per review as shown (newest last). */
export const MAX_SHOWN = 600;
export const MAX_TEXT = 80;
/** How long a deleted review's marker is kept, so a device that hadn't seen the delete can't bring it back. */
export const KEEP_DELETED_MS = 90 * 86_400_000;
/** Photos on one slide of a review at most. */
export const PER_SLIDE = 6;

export interface Review {
  /** random, 16 hex characters */
  id: string;
  name: string;
  /** what's typed in search: words, people, places, dates */
  query: string;
  every: Every;
  count: number;
  /** a notification when it's due (Android) */
  notify: boolean;
  created: number;
  updated: number;
}

export interface Shown {
  /** the period it was last watched in (periodOf) */
  period: number;
  /** the photos shown, oldest first */
  ids: string[];
  /** what that period's story showed, so it plays the same again until the next period */
  now: string[];
}

export interface ReviewDoc {
  v: 1;
  reviews: Review[];
  shown: Record<string, Shown>;
  /** review id → when it was deleted (ms) */
  deleted: Record<string, number>;
}

export interface ReviewItem {
  id: string;
  kind: string;
  created_at: number;
  broken?: boolean;
  trashed_at?: number;
  has_thumb?: boolean;
  favorite?: boolean;
  meta?: { capture_ts?: number; name?: string; locked?: unknown };
}

export const emptyDoc = (): ReviewDoc => ({ v: 1, reviews: [], shown: {}, deleted: {} });

// ---- periods, in local time ----

/** Days since 1970-01-01 of a local calendar day, whatever the clock changes. */
const dayNo = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

/** The number of the day, week (Monday to Sunday) or month a moment falls in; 0 is the one with 1970-01-01. */
export function periodOf(every: Every, d: Date): number {
  if (every === "month") return (d.getFullYear() - 1970) * 12 + d.getMonth();
  const day = dayNo(d);
  // 1970-01-01 was a Thursday: its week began on Monday, three days before
  return every === "week" ? Math.floor((day + 3) / 7) : day;
}

/** Where a period starts (local midnight). */
function periodStart(every: Every, p: number): Date {
  if (every === "month") return new Date(1970 + Math.floor(p / 12), ((p % 12) + 12) % 12, 1);
  const day = every === "week" ? p * 7 - 3 : p;
  const u = new Date(day * 86_400_000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** Due: not watched yet in this period (on any device). */
export const isDue = (r: Review, doc: ReviewDoc, now: Date): boolean =>
  (doc.shown[r.id]?.period ?? -Infinity) < periodOf(r.every, now);

/** When it's due next: now, if it's due; else the start of the next period. */
export const nextDue = (r: Review, doc: ReviewDoc, now: Date): Date =>
  isDue(r, doc, now) ? now : periodStart(r.every, periodOf(r.every, now) + 1);

// ---- picking ----

/** FNV-1a (32 bits) of the review id and the period, so every device picks the same in a period. */
export function seedOf(id: string, period: number): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(`${id}:${period}`)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}

/** mulberry32: small, fast, and the same in Swift; numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Can be shown: has a picture, isn't damaged, trashed or in the locked folder. */
export const showable = (i: ReviewItem): boolean =>
  !i.broken && !i.trashed_at && i.has_thumb !== false && i.meta?.locked !== true && (i.kind === "image" || i.kind === "video");

const byTime = (a: ReviewItem, b: ReviewItem) => captured(a) - captured(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const monthOf = (i: ReviewItem) => { const d = new Date(captured(i)); return d.getFullYear() * 12 + d.getMonth(); };
const plain = (i: ReviewItem) => i.kind === "image" && !looksLikeScreenshot(i.meta?.name);

/**
 * The photos a review shows this time, in capture order:
 * 1. the matches not shown lately; when there are fewer than `count`, those shown longest ago fill up;
 * 2. spread over the months they were taken in: the months in a random order, one photo from each in turn, a favorite
 *    twice as likely as another photo, screenshots and videos only where a month has nothing else.
 * `shown`: the review's history, oldest first. `seed`: seedOf(review, period).
 */
export function pickReview<T extends ReviewItem>(matches: readonly T[], count: number, shown: readonly string[], seed: number): T[] {
  const seen = new Map<string, number>();
  shown.forEach((id, k) => seen.set(id, k));
  const unique = new Map<string, T>();
  for (const m of matches) if (showable(m) && !unique.has(m.id)) unique.set(m.id, m);
  const all = [...unique.values()].sort(byTime);
  const fresh = all.filter((m) => !seen.has(m.id));
  const pool = fresh.length >= count ? fresh
    : [...fresh, ...all.filter((m) => seen.has(m.id)).sort((a, b) => seen.get(a.id)! - seen.get(b.id)!).slice(0, count - fresh.length)];

  const rnd = mulberry32(seed);
  const months = new Map<number, T[]>();
  for (const m of pool) (months.get(monthOf(m)) ?? months.set(monthOf(m), []).get(monthOf(m))!).push(m);
  const order = [...months.keys()].sort((a, b) => a - b);
  for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }

  const out: T[] = [];
  while (out.length < count && order.length) {
    for (let g = 0; g < order.length && out.length < count;) {
      const left = months.get(order[g])!;
      const nice = left.filter(plain);
      const from = nice.length ? nice : left;
      const total = from.reduce((s, m) => s + (m.favorite ? 2 : 1), 0);
      let r = rnd() * total, k = 0;
      for (; k < from.length - 1; k++) { r -= from[k].favorite ? 2 : 1; if (r < 0) break; }
      out.push(from[k]);
      left.splice(left.indexOf(from[k]), 1);
      if (left.length) g++; else order.splice(g, 1);
    }
  }
  return out.sort(byTime);
}

/** What this period's story showed, if it was watched in this period and those photos are still there. */
export function replayed<T extends ReviewItem>(doc: ReviewDoc, id: string, period: number, matches: readonly T[]): T[] | undefined {
  const s = doc.shown[id];
  if (!s || s.period !== period) return;
  const want = new Set(s.now);
  const got = matches.filter((m) => want.has(m.id) && showable(m));
  const once = [...new Map(got.map((m) => [m.id, m])).values()];
  return once.length ? once.sort(byTime) : undefined;
}

// ---- the document ----

const clone = (d: ReviewDoc): ReviewDoc => JSON.parse(JSON.stringify(d));

/** Remembers that a review was watched in a period with these photos. */
export function recordShown(doc: ReviewDoc, id: string, period: number, ids: readonly string[]): ReviewDoc {
  const d = clone(doc);
  const now = new Set(ids);
  const prev = (d.shown[id]?.ids ?? []).filter((x) => !now.has(x));
  d.shown[id] = { period, ids: [...prev, ...now].slice(-MAX_SHOWN), now: [...now] };
  return d;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "");
const snap = (n: unknown) => COUNTS.reduce((best, c) => (Math.abs(c - Number(n)) < Math.abs(best - Number(n)) ? c : best), COUNTS[0] as number);

/** Adds a review or changes one (by id). A review deleted on another device stays deleted. Throws without a query or
 *  when there are MAX_REVIEWS already. */
export function upsertReview(doc: ReviewDoc, r: Review, now: number): ReviewDoc {
  const query = clean(r.query);
  if (!query) throw new Error("A review needs something to search for.");
  if (doc.deleted[r.id] !== undefined) return doc;
  const d = clone(doc);
  const next: Review = {
    ...r, query, name: clean(r.name) || query, every: EVERY.includes(r.every) ? r.every : "day", count: Number.isFinite(Number(r.count)) ? snap(r.count) : 12,
    notify: !!r.notify, updated: now,
  };
  const k = d.reviews.findIndex((x) => x.id === r.id);
  if (k >= 0) d.reviews[k] = next;
  else if (d.reviews.length >= MAX_REVIEWS) throw new Error(`At most ${MAX_REVIEWS} reviews.`);
  else d.reviews.push({ ...next, created: now });
  return d;
}

export function deleteReview(doc: ReviewDoc, id: string, now: number): ReviewDoc {
  const d = clone(doc);
  d.reviews = d.reviews.filter((r) => r.id !== id);
  delete d.shown[id];
  d.deleted[id] = now;
  return d;
}

/** Drops delete markers older than KEEP_DELETED_MS and the history of reviews that are gone. */
export function tidy(doc: ReviewDoc, now: number): ReviewDoc {
  const d = clone(doc);
  for (const [id, at] of Object.entries(d.deleted)) if (now - at > KEEP_DELETED_MS) delete d.deleted[id];
  const ids = new Set(d.reviews.map((r) => r.id));
  for (const id of Object.keys(d.shown)) if (!ids.has(id)) delete d.shown[id];
  return d;
}

const isReview = (r: unknown): r is Review => {
  const x = r as Review;
  return !!x && typeof x.id === "string" && !!x.id && typeof x.name === "string" && typeof x.query === "string" && !!x.query.trim()
    && EVERY.includes(x.every) && Number.isFinite(x.count) && Number.isFinite(x.created) && Number.isFinite(x.updated);
};
const isShown = (s: unknown): s is Shown => {
  const x = s as Shown;
  return !!x && Number.isFinite(x.period) && Array.isArray(x.ids) && x.ids.every((i) => typeof i === "string")
    && (x.now === undefined || (Array.isArray(x.now) && x.now.every((i) => typeof i === "string")));
};

/** The document as opened: anything damaged left out, anything a newer app added to a review kept. */
export function readDoc(raw: unknown): ReviewDoc {
  const r = raw as Partial<ReviewDoc> | null;
  const d = emptyDoc();
  if (!r || typeof r !== "object") return d;
  if (Array.isArray(r.reviews)) d.reviews = r.reviews.filter(isReview).slice(0, MAX_REVIEWS);
  if (r.shown && typeof r.shown === "object") for (const [k, v] of Object.entries(r.shown)) if (isShown(v)) d.shown[k] = { ...v, now: v.now ?? [] };
  if (r.deleted && typeof r.deleted === "object") for (const [k, v] of Object.entries(r.deleted)) if (Number.isFinite(v)) d.deleted[k] = v;
  return d;
}

// ---- the story ----

export type ReviewSlide<T> =
  | { kind: "rcover"; item: T; name: string; total: number; shown: number }
  | { kind: "ryear"; year: number; photos: T[] }
  | { kind: "rend" };

/** The slides of a review: the cover (its first favorite, else its middle photo), the photos by year (PER_SLIDE a slide
 *  at most), the end. `picked`: pickReview's or replayed's answer; `total`: how many photos match the search. */
export function reviewSlides<T extends ReviewItem>(r: Review, picked: readonly T[], total: number): ReviewSlide<T>[] {
  if (!picked.length) return [{ kind: "rend" }];
  const fav = picked.find((p) => p.favorite && p.kind === "image");
  const cover = fav ?? picked.filter((p) => p.kind === "image")[Math.floor((picked.filter((p) => p.kind === "image").length - 1) / 2)] ?? picked[0];
  const out: ReviewSlide<T>[] = [{ kind: "rcover", item: cover, name: r.name, total, shown: picked.length }];
  const years = new Map<number, T[]>();
  for (const p of picked) { const y = new Date(captured(p)).getFullYear(); (years.get(y) ?? years.set(y, []).get(y)!).push(p); }
  for (const [year, photos] of [...years].sort((a, b) => a[0] - b[0]))
    for (let k = 0; k < photos.length; k += PER_SLIDE) out.push({ kind: "ryear", year, photos: photos.slice(k, k + PER_SLIDE) });
  out.push({ kind: "rend" });
  return out;
}
