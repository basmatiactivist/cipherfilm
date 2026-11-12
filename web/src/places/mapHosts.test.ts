import { describe, expect, it } from "vitest";
import { DEFAULT_MAP, httpsMap, httpsStyle, mapHosts, mapProviderOf } from "./mapHosts";

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

describe("httpsMap", () => {
  it("keeps the default and other https styles", () => {
    expect(httpsMap(DEFAULT_MAP)).toEqual(DEFAULT_MAP);
    expect(httpsStyle("https://maps.example.org:8443/s.json?key=1")).toBe(true);
  });
  it("drops inline style JSON, http:// and anything without a plain host", () => {
    const inline = JSON.stringify({ version: 8, sources: { t: { type: "raster", tiles: ["https://tracker.example/{z}/{x}/{y}.png"] } }, layers: [] });
    for (const u of [inline, "http://maps.example.org/s.json", "https://user@maps.example.org/s.json", "file:///s.json", "asset://s.json", "https://", " https://maps.example.org/s.json"]) {
      expect(httpsStyle(u)).toBe(false);
    }
    expect(httpsMap({ light: [inline, DEFAULT_MAP.light[0]], dark: ["http://x.example/d.json", DEFAULT_MAP.dark[1]] }))
      .toEqual({ light: [DEFAULT_MAP.light[0]], dark: [DEFAULT_MAP.dark[1]] });
    // nothing left on a side: no map rather than a style the question never named
    expect(httpsMap({ light: [inline], dark: DEFAULT_MAP.dark })).toBeUndefined();
    expect(httpsMap(null)).toBeUndefined();
  });
});
