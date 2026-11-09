// @ts-nocheck (Node APIs; vitest only)
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { label, Places, summary } from "./places";

let p: Places;
beforeAll(() => {
  const b = readFileSync(new URL("./places-v1.bin", import.meta.url));
  p = new Places(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
});

describe("place names on the device", () => {
  it("reads the whole file", () => {
    expect(p.n).toBeGreaterThan(150000);
    expect(p.countries.find(([c]) => c === "CH")?.[1]).toBe("Switzerland");
  });
  it("finds the nearest place to a photo's coordinates", () => {
    expect(label(p.nearest(47.3769, 8.5417))).toBe("Zürich, Switzerland");
    expect(label(p.nearest(48.8584, 2.2945))).toMatch(/, France$/); // the Eiffel Tower: Paris or a neighbouring town
    expect(p.nearest(48.8566, 2.3522)?.place?.name).toBe("Paris");
    expect(label(p.nearest(40.7128, -74.006))).toMatch(/United States$/);
    expect(label(p.nearest(-33.8688, 151.2093))).toMatch(/Australia$/);
    // across the antimeridian and near the poles it still works
    expect(p.nearest(-18.14, 178.44)?.countryCode).toBe("FJ");
  });
  it("gives no place in the open sea, and nothing for bad coordinates", () => {
    expect(p.nearest(0, -30)).toBeNull(); // mid-Atlantic
    expect(p.nearest(NaN, 1)).toBeNull();
    expect(p.nearest(91, 0)).toBeNull();
  });
  it("matches places, regions and countries by what is typed, with or without accents", () => {
    const zurich = p.nearestIndex(47.3769, 8.5417);
    expect(p.match("zurich").places.has(zurich)).toBe(true);
    expect(p.match("Zürich").places.has(zurich)).toBe(true);
    expect(p.match("switzerland").countries.has(p.countryOf(zurich))).toBe(true);
    expect(p.match("ch").countries.has(p.countryOf(zurich))).toBe(true);
    expect(p.match("z").places.size).toBe(0);
  });
  it("is fast enough for a library: 10,000 lookups well under a second", () => {
    const t = performance.now();
    for (let i = 0; i < 10000; i++) p.nearest(-60 + (i % 120), -170 + (i * 7) % 340);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("a title for photos from several places", () => {
  const zurich = () => p.nearest(47.3769, 8.5417), lucerne = () => p.nearest(47.0502, 8.3093), paris = () => p.nearest(48.8566, 2.3522);
  it("the place when all photos are from it", () => {
    expect(summary([zurich(), zurich()])).toEqual({ place: "Zürich, Switzerland", countries: ["Switzerland"] });
  });
  it("the countries, most photos first, when the places differ", () => {
    expect(summary([zurich(), lucerne()])).toEqual({ countries: ["Switzerland"] });
    expect(summary([paris(), zurich(), lucerne()])).toEqual({ countries: ["Switzerland", "France"] });
  });
  it("nothing for photos far from any place", () => {
    expect(summary([p.nearest(0, -30)])).toEqual({ countries: [] });
  });
});

describe("a big city reaches farther than its point", () => {
  it("the Eiffel Tower is in Paris, the middle of Neuilly in Neuilly", () => {
    expect(label(p.nearest(48.8584, 2.2945))).toBe("Paris, France");
    expect(label(p.nearest(48.8846, 2.2697))).toBe("Neuilly-sur-Seine, France");
  });
  it("a town next to a big city stays itself", () => {
    expect(label(p.nearest(47.3236, 8.5466))).toBe("Kilchberg, Switzerland"); // beside Zürich
    expect(label(p.nearest(48.8352, 2.241))).toBe("Boulogne-Billancourt, France"); // beside Paris
    expect(label(p.nearest(48.8049, 2.1204))).toBe("Versailles, France");
  });
  it("Zürich's main station and old town are in Zürich", () => {
    expect(label(p.nearest(47.3779, 8.5403))).toBe("Zürich, Switzerland");
    expect(label(p.nearest(47.3717, 8.5423))).toBe("Zürich, Switzerland");
  });
});
