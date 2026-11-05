import { describe, expect, it } from "vitest";
import { haystack, matches } from "./search";
import type { Item } from "./items";

const item = (meta: Partial<NonNullable<Item["meta"]>>, kind: Item["kind"] = "image"): Item =>
  ({ id: "x", kind, size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true, meta: { name: "IMG_0001.HEIC", mime: "image/heic", size: 1, lastModified: 0, capture_ts: new Date(2023, 2, 14, 10).getTime(), ...meta } } as Item);

describe("search", () => {
  const h = haystack(item({ make: "Apple", model: "iPhone 15 Pro" }), ["Holidays Italy"]);
  it("matches the file name and its type", () => {
    expect(matches(h, "img_0001")).toBe(true);
    expect(matches(h, "heic")).toBe(true);
    expect(matches(h, "photo")).toBe(true);
    expect(matches(h, "video")).toBe(false);
  });
  it("matches the capture date in several forms", () => {
    for (const q of ["2023", "march", "mar", "2023-03", "2023-03-14", "14.03.2023", "14.3.2023", "march 2023"]) expect(matches(h, q), q).toBe(true);
    expect(matches(h, "april")).toBe(false);
    expect(matches(h, "2024")).toBe(false);
  });
  it("matches camera and album, and needs every word", () => {
    expect(matches(h, "iphone")).toBe(true);
    expect(matches(h, "italy")).toBe(true);
    expect(matches(h, "iphone 2023 italy")).toBe(true);
    expect(matches(h, "iphone 2022")).toBe(false);
  });
  it("finds videos by type and handles missing metadata", () => {
    expect(matches(haystack(item({ name: "clip.mp4" }, "video")), "video")).toBe(true);
    expect(haystack({ id: "y", kind: "other", size: 0, segment_count: 1, created_at: 0, has_thumb: false, has_preview: false } as Item)).toContain("file");
    expect(matches("anything", "")).toBe(true);
  });
});
