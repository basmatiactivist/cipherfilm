import { describe, expect, test } from "vitest";
import fixture from "./testdata/custom.json";
import {
  COUNTS, MAX_REVIEWS, MAX_SHOWN, deleteReview, emptyDoc, isDue, mulberry32, nextDue, pickReview, periodOf, readDoc,
  recordShown, replayed, reviewSlides, seedOf, tidy, upsertReview, type Review, type ReviewItem,
} from "./custom";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const review = (o: Partial<Review> = {}): Review => ({ id: "r1", name: "Dogs", query: "dog", every: "day", count: 6, notify: true, created: 1, updated: 1, ...o });
const item = (id: string, y: number, m: number, d = 15, o: Partial<ReviewItem> = {}): ReviewItem =>
  ({ id, kind: "image", created_at: 0, meta: { capture_ts: at(y, m, d).getTime() }, ...o });

describe("the shared fixture (the Mac checks the same file)", () => {
  test("periods", () => {
    for (const c of fixture.periods) expect(periodOf(c.every as Review["every"], at(c.y, c.m, c.d, c.h)), JSON.stringify(c)).toBe(c.period);
  });
  test("seeds and random numbers", () => {
    for (const c of fixture.seeds) expect(seedOf(c.id, c.period)).toBe(c.seed);
    const r = mulberry32(fixture.random.seed);
    expect(fixture.random.values.map(() => Math.round(r() * 1e9))).toEqual(fixture.random.values);
  });
  test("picks", () => {
    type Fx = { id: string; y: number; m: number; d: number; favorite?: boolean; kind?: string; name?: string };
    for (const c of fixture.picks) {
      const items = (c.items as Fx[]).map((x) => item(x.id, x.y, x.m, x.d, { favorite: x.favorite, kind: x.kind ?? "image", meta: { capture_ts: at(x.y, x.m, x.d).getTime(), name: x.name } }));
      expect(pickReview(items, c.count, c.shown, c.seed).map((x) => x.id), c.name).toEqual(c.want);
    }
  });
});

describe("periods", () => {
  test("a day, a week from Monday, a calendar month", () => {
    expect(periodOf("day", at(1970, 1, 1))).toBe(0);
    expect(periodOf("day", at(1970, 1, 2, 0))).toBe(1);
    expect(periodOf("week", at(1969, 12, 29))).toBe(0); // a Monday
    expect(periodOf("week", at(1970, 1, 4, 23))).toBe(0); // the Sunday after
    expect(periodOf("week", at(1970, 1, 5, 0))).toBe(1);
    expect(periodOf("month", at(1970, 1, 31))).toBe(0);
    expect(periodOf("month", at(2026, 11, 20))).toBe(56 * 12 + 10);
  });
  test("a clock change doesn't skip or repeat a day", () => {
    // Europe moves the clock on the last Sundays of March and October; local days stay one apart whatever the zone
    const days = [25, 26, 27, 28, 29, 30, 31].map((d) => periodOf("day", at(2026, 3, d, 0)));
    expect(days.slice(1).map((x, i) => x - days[i])).toEqual([1, 1, 1, 1, 1, 1]);
    const oct = [24, 25, 26].map((d) => periodOf("day", at(2026, 10, d, 23)));
    expect(oct).toEqual([oct[0], oct[0] + 1, oct[0] + 2]);
  });
  test("due once per period; the next one starts at the period's start", () => {
    const r = review({ every: "week" });
    const now = at(2026, 11, 20); // a Friday
    expect(isDue(r, emptyDoc(), now)).toBe(true);
    const seen = recordShown(emptyDoc(), r.id, periodOf("week", now), ["a"]);
    expect(isDue(r, seen, now)).toBe(false);
    expect(isDue(r, seen, at(2026, 11, 23, 0))).toBe(true);
    expect(nextDue(r, seen, now)).toEqual(at(2026, 11, 23, 0));
    expect(nextDue({ ...r, every: "month" }, recordShown(emptyDoc(), r.id, periodOf("month", now), []), now)).toEqual(at(2026, 12, 1, 0));
    expect(nextDue({ ...r, every: "day" }, recordShown(emptyDoc(), r.id, periodOf("day", now), []), now)).toEqual(at(2026, 11, 21, 0));
    expect(nextDue(r, emptyDoc(), now)).toEqual(now);
  });
});

describe("picking", () => {
  const lib = Array.from({ length: 40 }, (_, i) => item(`i${String(i).padStart(2, "0")}`, 2020 + (i % 5), 1 + (i % 12), 1 + (i % 27)));
  const ids = (xs: ReviewItem[]) => xs.map((x) => x.id);

  test("the same seed gives the same story, another seed another one", () => {
    expect(ids(pickReview(lib, 6, [], 1))).toEqual(ids(pickReview(lib, 6, [], 1)));
    expect(ids(pickReview(lib, 6, [], 1))).not.toEqual(ids(pickReview(lib, 6, [], 2)));
  });
  test("in capture order, no photo twice, at most count", () => {
    const p = pickReview([...lib, ...lib], 12, [], 7);
    expect(new Set(ids(p)).size).toBe(12);
    const ts = p.map((x) => x.meta!.capture_ts!);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
  test("fewer matches than count: all of them", () => {
    expect(ids(pickReview(lib.slice(0, 3), 12, [], 1)).sort()).toEqual(["i00", "i01", "i02"]);
    expect(pickReview([], 6, [], 1)).toEqual([]);
  });
  test("photos shown lately don't come back until the others have been shown", () => {
    let doc = emptyDoc();
    const seen = new Set<string>();
    for (let period = 0; period < 6; period++) {
      const p = pickReview(lib, 6, doc.shown.r1?.ids ?? [], seedOf("r1", period));
      for (const x of p) { if (period < 6) expect(seen.has(x.id)).toBe(false); seen.add(x.id); }
      doc = recordShown(doc, "r1", period, ids(p));
    }
    expect(seen.size).toBe(36);
    // the 7th time: the four never shown, then the two shown longest ago
    const seventh = pickReview(lib, 6, doc.shown.r1.ids, seedOf("r1", 6));
    const never = ids(lib).filter((x) => !seen.has(x));
    expect(never.every((x) => ids(seventh).includes(x))).toBe(true);
    const oldest = doc.shown.r1.ids.slice(0, 6);
    expect(ids(seventh).filter((x) => !never.includes(x)).every((x) => oldest.includes(x))).toBe(true);
  });
  test("history pointing at photos that are gone doesn't matter", () => {
    expect(pickReview(lib.slice(0, 8), 6, ["gone1", "gone2", "i00"], 3).length).toBe(6);
  });
  test("spread over the months: one month full of photos doesn't take the whole story", () => {
    const busy = [...Array.from({ length: 30 }, (_, i) => item(`b${i}`, 2024, 7, 1 + (i % 28))), item("x1", 2021, 3), item("x2", 2022, 5), item("x3", 2023, 9)];
    const p = ids(pickReview(busy, 6, [], 11));
    expect(["x1", "x2", "x3"].every((x) => p.includes(x))).toBe(true);
  });
  test("screenshots and videos only where a month has nothing else", () => {
    const m = [item("shot", 2024, 1, 2, { meta: { capture_ts: at(2024, 1, 2).getTime(), name: "Screenshot_2024.png" } }), item("vid", 2024, 1, 3, { kind: "video" }), item("pic", 2024, 1, 4), item("v2", 2024, 2, 4, { kind: "video" })];
    expect(ids(pickReview(m, 2, [], 5))).toEqual(["pic", "v2"]);
  });
  test("nothing without a thumbnail, broken, trashed or locked", () => {
    const bad = [item("a", 2024, 1, 1, { has_thumb: false }), item("b", 2024, 1, 1, { broken: true }), item("c", 2024, 1, 1, { trashed_at: 5 }),
      item("d", 2024, 1, 1, { meta: { capture_ts: 1, locked: true } }), item("ok", 2024, 1, 1)];
    expect(ids(pickReview(bad, 6, [], 1))).toEqual(["ok"]);
  });
});

describe("the document", () => {
  test("the same period plays what it played (another device's pick included)", () => {
    const lib = [item("a", 2020, 1), item("b", 2021, 1), item("c", 2022, 1)];
    const doc = recordShown(emptyDoc(), "r1", 5, ["c", "a"]);
    expect(replayed(doc, "r1", 5, lib)?.map((x) => x.id)).toEqual(["a", "c"]);
    expect(replayed(doc, "r1", 6, lib)).toBeUndefined();
    expect(replayed(recordShown(emptyDoc(), "r1", 5, ["gone"]), "r1", 5, lib)).toBeUndefined();
  });
  test("history: newest last, trimmed, a set shown again moves to the end", () => {
    let d = recordShown(emptyDoc(), "r1", 1, ["a", "b"]);
    d = recordShown(d, "r1", 2, ["c", "a"]);
    expect(d.shown.r1).toEqual({ period: 2, ids: ["b", "c", "a"], now: ["c", "a"] });
    d = recordShown(d, "r1", 3, Array.from({ length: MAX_SHOWN + 5 }, (_, i) => `x${i}`));
    expect(d.shown.r1.ids.length).toBe(MAX_SHOWN);
    expect(d.shown.r1.ids.at(-1)).toBe(`x${MAX_SHOWN + 4}`);
  });
  test("adding and editing clean the input; a deleted review stays deleted", () => {
    let d = upsertReview(emptyDoc(), review({ name: "  ", query: "  dogs at the beach  ", count: 7 as never, every: "hourly" as never }), 10);
    expect(d.reviews[0]).toMatchObject({ name: "dogs at the beach", query: "dogs at the beach", count: 6, every: "day", updated: 10 });
    d = upsertReview(d, { ...d.reviews[0], name: "Beach dogs", count: 30 }, 11);
    expect(d.reviews).toHaveLength(1);
    expect(d.reviews[0]).toMatchObject({ name: "Beach dogs", count: 30, updated: 11 });
    d = recordShown(d, "r1", 1, ["a"]);
    d = deleteReview(d, "r1", 12);
    expect(d.reviews).toEqual([]);
    expect(d.shown.r1).toBeUndefined();
    expect(d.deleted.r1).toBe(12);
    // an edit made on a device that hadn't seen the delete
    expect(upsertReview(d, review(), 13).reviews).toEqual([]);
    expect(() => upsertReview(emptyDoc(), review({ query: "" }), 1)).toThrow();
    expect(COUNTS).toEqual([6, 12, 20, 30]);
  });
  test("at most MAX_REVIEWS", () => {
    let d = emptyDoc();
    for (let i = 0; i < MAX_REVIEWS; i++) d = upsertReview(d, review({ id: `r${i}` }), 1);
    expect(() => upsertReview(d, review({ id: "one more" }), 1)).toThrow();
  });
  test("tidy: markers go after 90 days, history of reviews that are gone goes", () => {
    const d = { ...emptyDoc(), deleted: { old: 0, fresh: 95 * 86_400_000 }, shown: { nobody: { period: 1, ids: ["a"], now: ["a"] } } };
    expect(tidy(d, 100 * 86_400_000)).toMatchObject({ deleted: { fresh: 95 * 86_400_000 }, shown: {} });
  });
  test("reading: a damaged or newer document doesn't break the app", () => {
    expect(readDoc(null)).toEqual(emptyDoc());
    expect(readDoc({ v: 1, reviews: [{ id: "x" }, review()], shown: { r1: { period: "x" } } })).toEqual({ ...emptyDoc(), reviews: [review()] });
    const newer = readDoc({ v: 1, reviews: [{ ...review(), color: "red" }], shown: {}, deleted: {}, extra: 1 });
    expect(newer.reviews[0]).toMatchObject({ color: "red" }); // kept, so an older app doesn't drop what a newer one added
  });
});

describe("slides", () => {
  test("cover, the years in order (six photos a slide at most), the end", () => {
    const picked = [item("a", 2019, 1), ...Array.from({ length: 8 }, (_, i) => item(`b${i}`, 2021, 1 + i)), item("c", 2023, 5, 1, { favorite: true })];
    const s = reviewSlides(review(), picked, 120);
    expect(s.map((x) => x.kind)).toEqual(["rcover", "ryear", "ryear", "ryear", "ryear", "rend"]);
    expect(s[0]).toMatchObject({ kind: "rcover", total: 120, shown: 10, item: { id: "c" } });
    expect(s.slice(1, 5).map((x) => x.kind === "ryear" && [x.year, x.photos.length])).toEqual([[2019, 1], [2021, 6], [2021, 2], [2023, 1]]);
    expect(reviewSlides(review(), [], 0).map((x) => x.kind)).toEqual(["rend"]);
  });
});
