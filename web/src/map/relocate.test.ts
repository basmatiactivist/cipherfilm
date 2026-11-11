import { describe, expect, it } from "vitest";
import { lackingVideos } from "./relocate";
import type { Item } from "../items";

const video = (id: string, meta: Record<string, unknown> = {}): Item => ({
  id, kind: "video", size: 1, segment_count: 1, created_at: 0, has_thumb: false, has_preview: false, itemKey: new Uint8Array(32),
  meta: { name: "v.mp4", mime: "video/mp4", size: 1, lastModified: 0, capture_ts: 0, ...meta },
});

describe("videos that still need a location", () => {
  it("leaves out a video whose place the person removed", () => {
    const items = [video("a"), video("b", { orig: { gps: { lat: 1, lon: 2 } } }), video("c", { gps: { lat: 3, lon: 4 } })];
    expect(lackingVideos(items, new Set()).map((x) => x.id)).toEqual(["a"]);
  });
});
