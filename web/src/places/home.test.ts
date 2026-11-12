import { describe, expect, it } from "vitest";
import { homeBounds } from "./home";

describe("where the map opens", () => {
  it("nothing located: no area (the whole world)", () => {
    expect(homeBounds([])).toBeNull();
  });
  it("the area with the most photos, not all of them", () => {
    const pts = [
      { lat: 47.37, lon: 8.54 }, { lat: 47.05, lon: 8.31 }, { lat: 46.95, lon: 7.45 }, // Zürich, Lucerne, Bern
      { lat: 51.5, lon: -0.12 }, { lat: 35.68, lon: 139.69 }, { lat: -33.87, lon: 151.21 },
    ];
    expect(homeBounds(pts)).toEqual([[7.45, 46.95], [8.54, 47.37]]);
  });
  it("one photo: its spot (the map keeps to region level)", () => {
    expect(homeBounds([{ lat: 40.7, lon: -74 }])).toEqual([[-74, 40.7], [-74, 40.7]]);
  });
  it("photos across a cell edge stay together", () => {
    const pts = [{ lat: 47.9, lon: 7.9 }, { lat: 48.1, lon: 8.1 }, { lat: 10, lon: 10 }];
    expect(homeBounds(pts)).toEqual([[7.9, 47.9], [8.1, 48.1]]);
  });
});
