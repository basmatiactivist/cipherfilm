import { describe, expect, it } from "vitest";
import { findMemories, looksLikeScreenshot, MEMORY_MAX_PER_YEAR, MEMORY_WINDOW_DAYS, pickCover, sample, todayKey, type MemoryItem } from "./memories";

// local times throughout: the selection works on the local calendar day, as the timeline does
let n = 0;
const at = (y: number, m: number, d: number, h = 12, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id: `i${n++}`, kind: "image", created_at: 0, has_thumb: true, meta: { name: `IMG_${n}.jpg`, capture_ts: new Date(y, m - 1, d, h).getTime() }, ...extra,
});
const now = new Date(2026, 10, 11, 9); // 11 November 2026

describe("findMemories", () => {
  it("groups photos from this date in earlier years, newest year first", () => {
    const items = [at(2023, 11, 11), at(2023, 11, 12), at(2020, 11, 10), at(2025, 11, 11), at(2024, 6, 1)];
    const m = findMemories(items, now);
    expect(m.map((x) => [x.year, x.yearsAgo, x.items.length])).toEqual([[2025, 1, 1], [2023, 3, 2], [2020, 6, 1]]);
  });

  it("is empty when nothing matches, and never shows this year", () => {
    expect(findMemories([], now)).toEqual([]);
    expect(findMemories([at(2026, 11, 11), at(2026, 11, 9), at(2024, 1, 1)], now)).toEqual([]);
  });

  it("uses a window of ±MEMORY_WINDOW_DAYS days", () => {
    expect(MEMORY_WINDOW_DAYS).toBe(3);
    const inside = [at(2022, 11, 8, 0), at(2022, 11, 14, 23)];
    const outside = [at(2022, 11, 7, 23), at(2022, 11, 15, 0)];
    const m = findMemories([...inside, ...outside], now);
    expect(m).toHaveLength(1);
    expect(m[0].items.map((i) => i.id)).toEqual(inside.map((i) => i.id));
    expect(findMemories([at(2022, 11, 13)], now, { window: 1 })).toEqual([]);
  });

  it("leaves out trashed, unreadable and non-media items", () => {
    const m = findMemories([
      at(2021, 11, 11, 12, { trashed_at: 123 }),
      at(2021, 11, 11, 12, { broken: true }),
      at(2021, 11, 11, 12, { kind: "other" }),
      { id: "nometa", kind: "image", created_at: new Date(2021, 10, 11).getTime() / 1000 },
    ], now);
    expect(m).toEqual([]);
  });

  it("orders a year's photos oldest first and covers the window across New Year", () => {
    const jan1 = new Date(2026, 0, 1, 10);
    const items = [at(2024, 1, 2), at(2023, 12, 30), at(2025, 12, 31)];
    const m = findMemories(items, jan1);
    // 30 Dec 2023 and 2 Jan 2024 belong to "1 January 2024"; 31 Dec 2025 is this year's (too recent)
    expect(m.map((x) => x.year)).toEqual([2024]);
    expect(m[0].items.map((i) => i.id)).toEqual([items[1].id, items[0].id]);
    expect(m[0].yearsAgo).toBe(2);
  });

  it("handles 29 February", () => {
    const leap = at(2024, 2, 29);
    // on 28 February 2025 the leap day is one day away
    expect(findMemories([leap], new Date(2025, 1, 28)).map((x) => x.year)).toEqual([2024]);
    // on 29 February 2028 a year without it uses the 28th: 1 March 2027 is one day off
    const m = findMemories([leap, at(2027, 3, 1), at(2027, 3, 4)], new Date(2028, 1, 29, 8));
    expect(m.map((x) => [x.year, x.items.length])).toEqual([[2027, 1], [2024, 1]]);
    // on 1 March 2025, the leap day (one day before 1 March 2024) counts for 2024
    expect(findMemories([leap], new Date(2025, 2, 1)).map((x) => x.year)).toEqual([2024]);
  });

  it("falls back to the upload time when the capture time is missing", () => {
    const it = { id: "x", kind: "image", created_at: new Date(2019, 10, 12).getTime() / 1000, meta: { name: "a.jpg" } };
    expect(findMemories([it], now).map((x) => x.year)).toEqual([2019]);
  });

  it("caps and samples a big year evenly, keeping the first and last", () => {
    const many = Array.from({ length: 1000 }, (_, i) => at(2020, 11, 11, 0, { meta: { name: `p${i}.jpg`, capture_ts: new Date(2020, 10, 11).getTime() + i * 60_000 } }));
    const [m] = findMemories(many, now);
    expect(m.total).toBe(1000);
    expect(m.items).toHaveLength(MEMORY_MAX_PER_YEAR);
    expect(m.items[0]).toBe(many[0]);
    expect(m.items.at(-1)).toBe(many[999]);
    expect(new Set(m.items).size).toBe(MEMORY_MAX_PER_YEAR);
    expect(findMemories(many, now, { max: 10 })[0].items).toHaveLength(10);
  });

  it("gives the cover's date", () => {
    const a = at(2023, 11, 9), b = at(2023, 11, 10), c = at(2023, 11, 13);
    const [m] = findMemories([c, a, b], now);
    expect(m.cover).toBe(b);
    expect(m.date).toBe(b.meta!.capture_ts);
  });
});

describe("pickCover", () => {
  it("prefers images in the middle of the set, then non-screenshots, then anything with a thumbnail", () => {
    const v1 = at(2020, 1, 1, 1, { kind: "video" }), i1 = at(2020, 1, 1, 2), i2 = at(2020, 1, 1, 3), i3 = at(2020, 1, 1, 4), v2 = at(2020, 1, 1, 5, { kind: "video" });
    expect(pickCover([v1, i1, i2, i3, v2])).toBe(i2);
    const shot = at(2020, 1, 1, 1, { meta: { name: "Screenshot_20200101.png", capture_ts: 1 } });
    expect(pickCover([shot, i1])).toBe(i1);
    expect(pickCover([shot, v1])).toBe(shot);
    const noThumb = at(2020, 1, 1, 1, { has_thumb: false });
    expect(pickCover([noThumb, v1])).toBe(v1);
    expect(pickCover([noThumb])).toBe(noThumb);
  });
});

describe("helpers", () => {
  it("recognises screenshots by name", () => {
    for (const s of ["Screenshot_20231111-101010.png", "Screen Shot 2019-01-01 at 10.00.00.png", "Bildschirmfoto 2023-11-11 um 10.00.00.png", "Screenshot 2023-11-11 101010.png", "Screen_Recording_2023.mp4"]) expect(looksLikeScreenshot(s)).toBe(true);
    for (const s of ["IMG_1234.JPG", "PXL_20231111_101010.jpg", "DSC0001.jpg", undefined]) expect(looksLikeScreenshot(s)).toBe(false);
  });
  it("samples evenly", () => {
    expect(sample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(sample([1, 2, 3], 1)).toEqual([1]);
  });
  it("keys the local day", () => {
    expect(todayKey(new Date(2026, 10, 11, 23, 59))).toBe("2026-11-11");
  });
});
