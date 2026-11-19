import { describe, expect, it } from "vitest";
import type { Recap, RecapItem } from "@memories/recap";
import { slideMs, storySlides, SLIDE_MS } from "./recapStory";

const it_ = (id: string, month: number, favorite = false): RecapItem & { id: string } =>
  ({ id, kind: "image", created_at: 0, favorite, meta: { capture_ts: new Date(2024, month, 10).getTime() } } as unknown as RecapItem & { id: string });

function recap(): Recap<RecapItem & { id: string }> {
  const a = it_("a", 0), b = it_("b", 0, true), c = it_("c", 6), d = it_("d", 6);
  return {
    year: 2024, photos: 4, videos: 0, days: 3, countries: 2, cover: a,
    places: [{ name: "Bern", country: "Schweiz", countryCode: "CH", count: 3, cover: c }, { name: "Paris", country: "France", countryCode: "FR", count: 1, cover: d }],
    people: [{ key: "anna", count: 3 }, { key: "g1:x", count: 2 }],
    months: [{ month: 0, total: 2, highlights: [a, b] }, { month: 6, total: 2, highlights: [c, d] }],
  };
}
const trip = (key: string, month: number, n: number, year = 2024) =>
  ({ key, title: key, start: new Date(year, month, 1).getTime(), items: Array.from({ length: n }, (_, i) => it_(`${key}${i}`, month)) });

describe("the year in review as a story", () => {
  it("cover, months, trips after their month, places, named people, end", () => {
    const s = storySlides(recap(), [trip("summer", 6, 5)], new Set(["anna"]));
    expect(s.map((x) => x.kind)).toEqual(["cover", "month", "month", "trip", "places", "people", "end"]);
    const people = s.find((x) => x.kind === "people");
    expect(people && people.kind === "people" && people.people.map((p) => p.key)).toEqual(["anna"]);
    const places = s.find((x) => x.kind === "places");
    expect(places && places.kind === "places" && places.others).toEqual(["Paris"]);
  });

  it("a month's favorite comes first, else its middle photo", () => {
    const m = storySlides(recap(), [], new Set())[1];
    expect(m.kind === "month" && m.photos.map((p) => p.id)).toEqual(["b", "a"]);
    const r = recap();
    const four = ["p", "q", "r", "s"].map((id) => it_(id, 6));
    r.months[1] = { month: 6, total: 4, highlights: four };
    const m2 = storySlides(r, [], new Set())[2];
    expect(m2.kind === "month" && m2.photos.map((p) => p.id)).toEqual(["q", "p", "r", "s"]);
  });

  it("only the three longest trips; one that began the year before comes after January", () => {
    const s = storySlides(recap(), [trip("t1", 6, 2), trip("t2", 6, 9), trip("t3", 6, 4), trip("t4", 6, 7), trip("nye", 11, 8, 2023)], new Set());
    expect(s.filter((x) => x.kind === "trip").map((x) => x.kind === "trip" && x.key)).toEqual(["nye", "t2", "t4"]);
    expect(s[2].kind).toBe("trip"); // right after January
  });

  it("no people or places: those slides are left out", () => {
    const r = { ...recap(), places: [], people: [] };
    expect(storySlides(r, [], new Set(["anna"])).map((x) => x.kind)).toEqual(["cover", "month", "month", "end"]);
  });

  it("a month with many photos stays longer", () => {
    const r = recap();
    expect(slideMs({ kind: "month", month: 0, total: 9, photos: [...r.months[0].highlights, ...r.months[1].highlights] })).toBe(Math.max(SLIDE_MS, 4 * 1500));
    expect(slideMs({ kind: "end" })).toBe(SLIDE_MS);
  });
});
