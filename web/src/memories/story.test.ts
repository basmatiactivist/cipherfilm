import { describe, expect, it } from "vitest";
import type { Recap, RecapItem } from "./recap";
import { bestFirst, PHOTO_MS, SLIDE_MS, slideMs, storySlides, type Slide, type StoryTrip } from "./story";

const pic = (id: string, extra: Partial<RecapItem> = {}): RecapItem => ({ id, kind: "image", created_at: 0, has_thumb: true, ...extra });
const ts = (y: number, m: number, d = 10) => new Date(y, m, d, 12).getTime();
const trip = (key: string, start: number, end: number, n: number, first?: RecapItem): StoryTrip<RecapItem> =>
  ({ key, start, end, items: [first ?? pic(`${key}-0`), ...Array.from({ length: n - 1 }, (_, i) => pic(`${key}-${i + 1}`))] });

const recap = (over: Partial<Recap<RecapItem>> = {}): Recap<RecapItem> => ({
  year: 2025, photos: 10, videos: 0, days: 5, countries: 1, cover: pic("cover"), places: [], people: [],
  months: [
    { month: 0, total: 3, highlights: [pic("a1"), pic("a2"), pic("a3")] },
    { month: 4, total: 1, highlights: [pic("m1")] },
    { month: 8, total: 2, highlights: [pic("s1"), pic("s2", { favorite: true })] },
  ],
  ...over,
});
const shape = (s: Slide<RecapItem>[]) => s.map((x) => (x.kind === "month" ? `month${x.month}` : x.kind === "trip" ? `trip:${x.key}` : x.kind));

describe("the story's slides", () => {
  it("are the cover, the months and the end at least", () => {
    expect(shape(storySlides(recap()))).toEqual(["cover", "month0", "month4", "month8", "end"]);
  });

  it("show a month's best photo first: the first favorite, else the middle one", () => {
    expect(bestFirst([pic("a"), pic("b"), pic("c", { favorite: true }), pic("d", { favorite: true })]).map((i) => i.id)).toEqual(["c", "a", "b", "d"]);
    expect(bestFirst([pic("a"), pic("b"), pic("c")]).map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(bestFirst([pic("a"), pic("b", { has_thumb: false })]).map((i) => i.id)).toEqual(["a"]);
  });

  it("put each trip after the month it starts in, at most the three longest", () => {
    const trips = [
      trip("may", ts(2025, 4, 3), ts(2025, 4, 8), 9),
      trip("sep", ts(2025, 8, 1), ts(2025, 8, 5), 12),
      trip("jan", ts(2025, 0, 2), ts(2025, 0, 4), 6),
      trip("short", ts(2025, 4, 20), ts(2025, 4, 22), 3), // the fourth longest: left out
      trip("old", ts(2023, 4, 3), ts(2023, 4, 8), 40), // another year
    ];
    expect(shape(storySlides(recap(), { trips }))).toEqual(["cover", "month0", "trip:jan", "month4", "trip:may", "month8", "trip:sep", "end"]);
  });

  it("put a trip from the year before first, and one without a month slide before the next month", () => {
    const trips = [trip("newyear", ts(2024, 11, 29), ts(2025, 0, 3), 8), trip("march", ts(2025, 2, 1), ts(2025, 2, 4), 5)];
    expect(shape(storySlides(recap(), { trips }))).toEqual(["cover", "trip:newyear", "month0", "trip:march", "month4", "month8", "end"]);
  });

  it("show a trip by its first photo, and leave out one with nothing to show", () => {
    const video = pic("v", { kind: "video" });
    const t = trip("t", ts(2025, 0, 3), ts(2025, 0, 6), 4, video);
    const s = storySlides(recap(), { trips: [t, { key: "none", start: ts(2025, 4, 1), end: ts(2025, 4, 3), items: [pic("x", { has_thumb: false })] }] });
    const slide = s.find((x) => x.kind === "trip");
    expect(slide && slide.kind === "trip" && slide.item.id).toBe("t-1");
    expect(s.filter((x) => x.kind === "trip")).toHaveLength(1);
  });

  it("end with the places and the named people", () => {
    const r = recap({
      places: [{ name: "Zürich", country: "Switzerland", countryCode: "CH", count: 9, cover: pic("z") }, { name: "Bern", country: "Switzerland", countryCode: "CH", count: 3, cover: pic("b") }],
      people: [{ key: "p1", count: 5 }, { key: "p2", count: 3 }],
    });
    const s = storySlides(r, { named: new Set(["p2"]) });
    expect(shape(s).slice(-3)).toEqual(["places", "people", "end"]);
    expect(s.at(-3)).toMatchObject({ name: "Zürich", country: "Switzerland", others: ["Bern"] });
    expect(s.at(-2)).toEqual({ kind: "people", people: [{ key: "p2", count: 3 }] });
    expect(shape(storySlides(r)).slice(-2)).toEqual(["places", "end"]); // nobody named: no people slide
  });

  it("give a month with several photos time for each", () => {
    const [, jan, may] = storySlides(recap());
    expect(slideMs(jan)).toBe(SLIDE_MS);
    expect(slideMs(may)).toBe(SLIDE_MS);
    expect(slideMs({ kind: "month", month: 0, total: 9, photos: [1, 2, 3, 4].map((i) => pic(`p${i}`)) })).toBe(4 * PHOTO_MS);
  });
});
