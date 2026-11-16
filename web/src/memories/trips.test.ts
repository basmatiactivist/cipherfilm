// @ts-nocheck (Node APIs; vitest only)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Places } from "../places/places";
import { findTrips, homeOf, savedAs, TRIP_MIN_DAYS, TRIP_MIN_ITEMS, TRIP_MIN_KM, tripDates, whereOf, whereText, type TripItem } from "./trips";
import { highlights, recapYears, yearRecap, type RecapItem } from "./recap";

// the fixture the Mac checks too (mac/Tests/CipherfilmCoreTests/TripsTests.swift)
const fx = JSON.parse(readFileSync(new URL("./testdata/trips.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../places/places-v1.bin", import.meta.url));
const places = new Places(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
const lookup = (lat: number, lon: number) => places.nearest(lat, lon);

describe("the shared fixture", () => {
  it("finds the same trips as on the other platforms", () => {
    const got = findTrips(fx.items, lookup).map((t) => ({ key: t.key, days: t.days, where: t.where, items: t.items.map((i) => i.id) }));
    expect(got).toEqual(fx.expected.trips);
  });

  it("makes the same year recap", () => {
    const r = yearRecap(fx.items, 2025, { lookup, people: fx.expected.people })!;
    expect({
      year: r.year, photos: r.photos, videos: r.videos, days: r.days, countries: r.countries, cover: r.cover.id, people: r.people,
      places: r.places.map((x) => ({ name: x.name, countryCode: x.countryCode, count: x.count, cover: x.cover.id })),
      months: r.months.map((m) => ({ month: m.month, total: m.total, highlights: m.highlights.map((i) => i.id) })),
    }).toEqual(fx.expected.recap);
  });

  it("offers the same years", () => {
    expect(recapYears(fx.items, new Date(2026, 10, 16))).toEqual(fx.expected.years["2026-11-16"]);
    expect(recapYears(fx.items, new Date(2026, 11, 2))).toEqual(fx.expected.years["2026-12-02"]);
  });
});

// local times: trips work on the local calendar day, as the timeline does
let n = 0;
const ZRH = { lat: 47.3769, lon: 8.5417 }, ROME = { lat: 41.9028, lon: 12.4964 };
const at = (where: { lat: number; lon: number } | null, y: number, m: number, d: number, h = 12, extra: Partial<TripItem> = {}): TripItem => ({
  id: `t${String(n++).padStart(3, "0")}`, kind: "image", created_at: 0, meta: { capture_ts: new Date(y, m - 1, d, h).getTime(), ...(where ? { gps: where } : {}) }, ...extra,
});
const homeDays = () => Array.from({ length: 10 }, (_, i) => at(ZRH, 2024, 1 + i, 3));

describe("findTrips", () => {
  it("uses the documented thresholds", () => {
    expect([TRIP_MIN_KM, TRIP_MIN_ITEMS, TRIP_MIN_DAYS]).toEqual([80, 5, 2]);
  });

  it("is empty without photos with a location", () => {
    expect(findTrips([])).toEqual([]);
    expect(findTrips([at(null, 2024, 5, 1), at(null, 2024, 5, 2)])).toEqual([]);
  });

  it("groups photos far from home on consecutive days, without a lookup naming nothing", () => {
    const trip = [at(ROME, 2024, 5, 10), at(ROME, 2024, 5, 10, 14), at(ROME, 2024, 5, 11), at(ROME, 2024, 5, 11, 15), at(ROME, 2024, 5, 12)];
    const t = findTrips([...homeDays(), ...trip]);
    expect(t).toHaveLength(1);
    expect(t[0].items.map((i) => i.id)).toEqual(trip.map((i) => i.id));
    expect(t[0].days).toBe(3);
    expect(t[0].where).toEqual({ kind: "none" });
  });

  it("allows one day without photos, not two", () => {
    const a = [at(ROME, 2024, 5, 10), at(ROME, 2024, 5, 10, 13), at(ROME, 2024, 5, 10, 14)];
    const b = [at(ROME, 2024, 5, 12), at(ROME, 2024, 5, 12, 13), at(ROME, 2024, 5, 12, 14)];
    expect(findTrips([...homeDays(), ...a, ...b])).toHaveLength(1);
    const c = b.map((x) => ({ ...x, meta: { ...x.meta, capture_ts: x.meta!.capture_ts! + 86_400_000 } }));
    expect(findTrips([...homeDays(), ...a, ...c])).toEqual([]); // two runs of one day each
  });

  it("leaves out trashed, broken and locked photos, and what isn't a photo or video", () => {
    const ok = [at(ROME, 2024, 5, 10), at(ROME, 2024, 5, 10, 13), at(ROME, 2024, 5, 11), at(ROME, 2024, 5, 11, 13)];
    const bad = [at(ROME, 2024, 5, 11, 14, { trashed_at: 1 }), at(ROME, 2024, 5, 11, 15, { broken: true }), at(ROME, 2024, 5, 11, 16, { meta: { capture_ts: new Date(2024, 4, 11, 16).getTime(), gps: ROME, locked: true } }), at(ROME, 2024, 5, 11, 17, { kind: "other" })];
    expect(findTrips([...homeDays(), ...ok, ...bad])).toEqual([]); // four left: too few
    expect(findTrips([...homeDays(), ...ok, at(ROME, 2024, 5, 11, 18)])).toHaveLength(1);
  });
});

describe("homeOf", () => {
  it("is the cell with photos on the most days, not the most photos", () => {
    const pts = [
      ...Array.from({ length: 50 }, () => ({ ...ROME, day: 1 })),
      ...Array.from({ length: 5 }, (_, i) => ({ ...ZRH, day: 10 + i })),
    ];
    const h = homeOf(pts)!;
    expect(h.lat).toBeCloseTo(ZRH.lat);
    expect(homeOf([])).toBeNull();
  });
});

describe("whereOf", () => {
  const hit = (name: string, region: string, country: string, countryCode: string) => ({ place: { name, region }, country, countryCode });
  it("names the place holding half, else the region, else the country", () => {
    expect(whereOf([hit("Rome", "Lazio", "Italy", "IT"), hit("Rome", "Lazio", "Italy", "IT"), hit("Tivoli", "Lazio", "Italy", "IT")]).kind).toBe("place");
    expect(whereOf([hit("Rome", "Lazio", "Italy", "IT"), hit("Tivoli", "Lazio", "Italy", "IT"), hit("Ostia", "Lazio", "Italy", "IT")])).toEqual({ kind: "region", name: "Lazio", country: "Italy", countryCode: "IT" });
    expect(whereOf([hit("Rome", "Lazio", "Italy", "IT"), hit("Florence", "Tuscany", "Italy", "IT"), hit("Milan", "Lombardy", "Italy", "IT")])).toEqual({ kind: "country", country: "Italy", countryCode: "IT" });
    expect(whereOf([null, undefined])).toEqual({ kind: "none" });
  });
});

describe("words", () => {
  const month = (ts: number) => new Intl.DateTimeFormat("en", { month: "long" }).format(ts);
  const monthYear = (ts: number) => new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(ts);
  it("reads the months of a trip", () => {
    expect(tripDates(+new Date(2026, 4, 3), +new Date(2026, 4, 9), month, monthYear)).toBe("May 2026");
    expect(tripDates(+new Date(2026, 4, 30), +new Date(2026, 5, 2), month, monthYear)).toBe("May – June 2026");
    expect(tripDates(+new Date(2025, 11, 30), +new Date(2026, 0, 2), month, monthYear)).toBe("December 2025 – January 2026");
  });
  it("reads where a trip was", () => {
    const c = (country: string) => ({ country, countryCode: country.slice(0, 2).toUpperCase() });
    expect(whereText({ kind: "countries", countries: [c("Italy"), c("France")] })).toBe("Italy and France");
    expect(whereText({ kind: "countries", countries: [c("Italy"), c("France"), c("Spain"), c("Monaco")] }, "und", (k) => `${k} weitere`)).toBe("Italy, France und 2 weitere");
    expect(whereText({ kind: "place", name: "Rome", country: "Italy", countryCode: "IT" })).toBe("Rome");
    expect(whereText({ kind: "none" })).toBe("");
  });
  it("knows an album that holds the trip", () => {
    const trip = { items: ["a", "b", "c", "d", "e"].map((id) => ({ id })) };
    expect(savedAs(trip, [{ itemIds: ["a", "b", "c", "x"] }])).toBeUndefined();
    expect(savedAs(trip, [{ itemIds: ["a", "b", "c", "d", "x"] }])).toBeDefined();
  });
});

describe("recap", () => {
  const it2 = (id: string, d: number, extra: Partial<RecapItem> = {}): RecapItem => ({ id, kind: "image", created_at: 0, has_thumb: true, meta: { name: `${id}.jpg`, capture_ts: new Date(2025, 2, d, 12).getTime() }, ...extra });
  it("puts favorites first, then one photo per day, never screenshots", () => {
    const list = [it2("a", 1), it2("b", 1), it2("c", 2, { favorite: true }), it2("d", 3), it2("e", 4, { meta: { name: "Screenshot 1.png", capture_ts: new Date(2025, 2, 4, 12).getTime() } }), it2("f", 5)];
    expect(highlights(list, 3).map((i) => i.id)).toEqual(["a", "c", "f"]);
    expect(highlights(list, 1).map((i) => i.id)).toEqual(["c"]);
  });
  it("has no recap for a year without photos, and this year only in December", () => {
    expect(yearRecap([it2("a", 1)], 2024)).toBeNull();
    expect(recapYears([it2("a", 1)], new Date(2025, 10, 30))).toEqual([]);
    expect(recapYears([it2("a", 1)], new Date(2025, 11, 1))).toEqual([2025]);
  });
});
