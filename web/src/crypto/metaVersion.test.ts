import { describe, expect, it } from "vitest";
import { HighWater, metaDigest, metaVersion, nextVersion } from "./metaVersion";

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

  it("is kept across restarts and reads only well-formed entries", () => {
    let saved: [string, number, string?][] = [];
    const h = new HighWater((e) => { saved = e; });
    h.check(A, 1); h.check(B, 2, "0123456789abcdef".repeat(4)); h.check(C, 0);
    h.flush();
    expect(saved).toEqual([[A, 1], [B, 2, "0123456789abcdef"]]); // ids, numbers and a short digest only
    const again = new HighWater(undefined, JSON.parse(JSON.stringify(saved)));
    expect(again.check(B, 1)).toBe(false);
    expect(again.check(B, 2, "f".repeat(64))).toBe(false); // another copy at the version seen
    expect(new HighWater(undefined, [["x", 5], [A, -1], [A, "2"], null, [B, 4]]).highest(B)).toBe(4);
    expect(new HighWater(undefined, "junk").highest(A)).toBe(0);
    // the format from before digests
    expect(new HighWater(undefined, [[A, 3]]).check(A, 3, "a".repeat(64))).toBe(true);
  });

  it("never forgets an item to make room: a full store can't check further items, they are refused", () => {
    // a server could list thousands of items it made itself (sealed to the account's public key) to push a real
    // item out of the store, then hand out that item's older metadata
    const h = new HighWater(undefined, undefined, 3);
    h.check(A, 2);
    for (let i = 0; i < 10; i++) h.check(i.toString(16).padStart(32, "0"), 1);
    expect(h.check(A, 1)).toBe(false); // still remembered
    expect(h.check(A, 0)).toBe(false);
    expect(h.highest(A)).toBe(2);
    expect(h.check("f".repeat(32), 1)).toBe(false); // can't be noted: handled as stale
    expect(h.check("e".repeat(32), 0)).toBe(true); // never changed: nothing to remember
    expect(h.check(A, 3)).toBe(true); // a known item still moves on
  });

  it("refuses another copy at the version seen (two changes made from the same older copy)", () => {
    const d1 = "1".repeat(64), d2 = "2".repeat(64);
    const h = new HighWater();
    expect(h.check(A, 1, d1)).toBe(true);
    expect(h.check(A, 1, d1)).toBe(true);
    expect(h.accepts(A, 1, d2)).toBe(false);
    expect(h.check(A, 1, d2)).toBe(false);
    expect(h.check(A, 1)).toBe(true); // no digest to compare (a caller that has none)
    expect(h.check(A, 2, d2)).toBe(true); // a newer change from it is fine
    // this device's own change is noted with its copy
    h.wrote(B, 1, d2);
    expect(h.check(B, 1, d1)).toBe(false);
  });

  it("names a sealed copy by the SHA-256 of its text", () => {
    expect(metaDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
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
