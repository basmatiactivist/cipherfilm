import { describe, expect, it } from "vitest";
import { candidateOf, findDuplicates } from "./duplicates";
import type { Item } from "./library";

let n = 0;
const item = (p: Partial<Item> = {}, meta: Partial<NonNullable<Item["meta"]>> = {}): Item => {
  n++;
  return {
    id: `${n}`.padStart(32, "0"), kind: "image", size: 100, segment_count: 1, created_at: 1000 + n, has_thumb: true, has_preview: true,
    meta: { name: `IMG_${n}.jpg`, mime: "image/jpeg", size: 100, lastModified: 0, capture_ts: 1_700_000_000_000 + n * 1000, ...meta }, ...p,
  };
};

describe("duplicates on the phone", () => {
  it("leaves out broken, trashed and unreadable items", () => {
    expect(candidateOf(item({ broken: true }))).toBeNull();
    expect(candidateOf(item({ trashed_at: 5 }))).toBeNull();
    expect(candidateOf(item({ meta: undefined }))).toBeNull();
    const c = candidateOf(item({ kind: "video" }, { gps: { lat: 1, lon: 2 }, width: 4, height: 3 }))!;
    expect(c).toMatchObject({ image: false, gps: true, width: 4, height: 3, size: 100 });
  });

  it("finds exact duplicates with search off, and asks the index nothing", async () => {
    const a = item({}, { name: "x.jpg", capture_ts: 5 }), b = item({}, { name: "x.jpg", capture_ts: 5 });
    const f = await findDuplicates([a, b, item()], {
      ready: false,
      indexedAmong: () => { throw new Error("asked"); },
      pairScores: () => { throw new Error("asked"); },
    });
    expect(f.exact).toHaveLength(1);
    expect(f.similar).toEqual([]);
    expect(f.searchOn).toBe(false);
    expect(f.indexed).toBe(0);
  });

  it("groups similar photos through the native index's scores", async () => {
    const shots = [item({}, { capture_ts: 0 }), item({}, { capture_ts: 1000, width: 10, height: 10 }), item({}, { capture_ts: 2000 })];
    const asked: string[][] = [];
    const f = await findDuplicates([...shots, item({ kind: "video" }, { capture_ts: 500 })], {
      ready: true,
      indexedAmong: async (ids) => { asked.push(ids); return new Set(ids); },
      pairScores: async (a, b) => a.map((x, k) => (x === shots[2].id || b[k] === shots[2].id ? 0.5 : 0.97)),
    });
    expect(asked[0]).toHaveLength(3); // only photos are looked up
    expect(f.similar).toHaveLength(1);
    expect(f.similar[0].keep).toBe(shots[1].id); // the higher resolution
    expect(new Set(f.similar[0].ids)).toEqual(new Set([shots[0].id, shots[1].id]));
  });
});
