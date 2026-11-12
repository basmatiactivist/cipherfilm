import { describe, expect, it } from "vitest";
import { HighWater, metaVersion, nextVersion } from "./metaVersion";

const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);

describe("metadata versions", () => {
  it("reads and raises the version, ignoring what isn't one", () => {
    expect(metaVersion({})).toBe(0);
    expect(metaVersion({ mv: 3 })).toBe(3);
    for (const mv of [-1, 1.5, "4", null, Number.MAX_SAFE_INTEGER + 2]) expect(metaVersion({ mv })).toBe(0);
    expect(nextVersion({ name: "x" })).toEqual({ name: "x", mv: 1 });
    expect(nextVersion({ name: "x", mv: 4 }).mv).toBe(5);
  });

  it("refuses an older version than one seen before, accepts the same or newer", () => {
    const h = new HighWater();
    expect(h.check(A, 2)).toBe(true);
    expect(h.check(A, 1)).toBe(false); // a replayed older copy
    expect(h.check(A, 0)).toBe(false); // the upload's metadata, after an edit
    expect(h.check(A, 2)).toBe(true);
    expect(h.check(A, 3)).toBe(true);
    expect(h.highest(A)).toBe(3);
    expect(h.check(B, 0)).toBe(true); // never changed: nothing kept
    expect(h.highest(B)).toBe(0);
  });

  it("is kept across restarts, bounded, and reads only well-formed entries", () => {
    let saved: [string, number][] = [];
    const h = new HighWater((e) => { saved = e; }, undefined, 2);
    h.check(A, 1); h.check(B, 2); h.check(C, 3);
    h.flush();
    expect(saved).toEqual([[B, 2], [C, 3]]); // the oldest noted went
    const again = new HighWater(undefined, JSON.parse(JSON.stringify(saved)));
    expect(again.check(C, 2)).toBe(false);
    expect(new HighWater(undefined, [["x", 5], [A, -1], [A, "2"], null, [B, 4]]).highest(B)).toBe(4);
    expect(new HighWater(undefined, "junk").highest(A)).toBe(0);
  });
});

describe("every change raises the version", () => {
  it("edits, new dates and places and a revert all keep it and write it one higher", async () => {
    const { reverted, withDate, withPicture, withPlace } = await import("../edit/edit");
    const m = { capture_ts: 1, gps: { lat: 1, lon: 2 }, mv: 3 };
    for (const changed of [withDate(m, 5), withPlace(m, null), withPicture(m, { rot: 90 }, "v1"), reverted(withPlace(m, null))]) {
      expect(nextVersion(changed).mv).toBe(4);
    }
  });
});
