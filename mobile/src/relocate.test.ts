import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("expo-asset", () => ({ Asset: { fromModule: () => ({}) } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("./api", () => ({ api: async () => ({}) }));
vi.mock("./session", () => ({ session: () => ({}), onWipe: () => {} }));
vi.mock("./libraryStore", () => ({ libraryItems: () => [], refreshLibrary: async () => {} }));

const { lacking, matchOnPhone } = await import("./relocate");
type Item = Parameters<typeof lacking>[0][number];

const item = (id: string, name: string, size: number, extra: Partial<Item> = {}): Item => ({
  id, kind: "image", size, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true,
  itemKey: new Uint8Array(32), meta: { name, mime: "image/jpeg", size, lastModified: 1, capture_ts: 1 }, ...extra,
});
const media = (id: number, name: string, size: number) => ({ id, uri: `content://media/external/images/media/${id}`, name, size, mime: "image/jpeg", bucket: "b", folder: "Camera", taken: 1 });

describe("adding where photos were taken afterwards", () => {
  it("looks only at finished photos and videos without a location, not looked at before", () => {
    const items = [
      item("a", "IMG_1.jpg", 10),
      item("b", "IMG_2.jpg", 10, { meta: { name: "IMG_2.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1, gps: { lat: 47, lon: 8 } } }),
      item("c", "IMG_3.jpg", 10, { broken: true }),
      item("d", "IMG_4.jpg", 10, { trashed_at: 5 }),
      item("e", "doc.pdf", 10, { kind: "other" }),
      item("f", "VID_1.mp4", 10, { kind: "video" }),
      item("g", "IMG_5.jpg", 10),
      // the person removed its place (editing): it stays without one
      item("h", "IMG_6.jpg", 10, { meta: { name: "IMG_6.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1, orig: { gps: { lat: 1, lon: 2 } } } }),
    ];
    expect(lacking(items, new Set(["g"])).map((i) => i.id)).toEqual(["a", "f"]);
  });

  it("finds the phone's file by name and size, or by the picker's number and size", async () => {
    const items = [item("a", "IMG_1.jpg", 100), item("b", "812.jpg", 200), item("c", "813.jpg", 300), item("d", "IMG_9.jpg", 5)];
    const phone = [media(1, "IMG_1.jpg", 100), media(812, "PXL_2026.jpg", 200), media(813, "other.jpg", 999), media(9, "IMG_9.jpg", 6)];
    const found = await matchOnPhone(items, phone);
    expect([...found].map(([it, m]) => [it.id, m.id])).toEqual([["a", 1], ["b", 812]]);
  });
});
