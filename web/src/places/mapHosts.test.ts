import { describe, expect, it } from "vitest";
import { DEFAULT_MAP, mapHosts, mapProviderOf } from "./mapHosts";

describe("map hosts", () => {
  it("calls only the exact default OpenFreeMap", () => {
    expect(mapProviderOf(DEFAULT_MAP)).toBe("OpenFreeMap");
    expect(mapProviderOf({ light: DEFAULT_MAP.light, dark: ["https://dark.example.org/s.json"] })).toBe(
      "tiles.openfreemap.org, tiles.versatiles.org, dark.example.org");
  });
  it("names every host of the light and dark styles once", () => {
    const own = { light: ["https://maps.example.org/l.json"], dark: ["https://Other.example.net:8443/d.json"] };
    expect(mapHosts(own)).toEqual(["maps.example.org", "other.example.net:8443"]);
    expect(mapProviderOf({ light: own.light, dark: own.light })).toBe("maps.example.org");
  });
  it("has nothing for no map", () => {
    expect(mapProviderOf(null)).toBe("");
    expect(mapHosts({ light: ["http://plain.example.org/x"] })).toEqual([]);
  });
});
