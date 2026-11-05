import { describe, expect, test } from "vitest";
import { parseRange, playMime, sliceFor, spanFor } from "./sw-range";
import { SEG_PLAIN } from "./crypto/file";

describe("parseRange", () => {
  test("open, closed, suffix and absent ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });
  test("unsatisfiable or unsupported ranges", () => {
    for (const h of ["bytes=100-", "bytes=50-10", "bytes=-0", "bytes=-", "items=0-5", "bytes=0-5,10-20", "garbage"]) {
      expect(parseRange(h, 100)).toBe("invalid");
    }
    expect(parseRange("bytes=0-", 0)).toBe("invalid");
  });
});

describe("segment math", () => {
  const total = 2 * SEG_PLAIN + 100;
  test("range inside one segment", () => {
    const r = { start: 10, end: 20 };
    expect(spanFor(r)).toEqual({ first: 0, last: 0 });
    expect(sliceFor(0, r, SEG_PLAIN)).toEqual([10, 21]);
  });
  test("range across the boundary", () => {
    const r = { start: SEG_PLAIN - 5, end: SEG_PLAIN + 4 };
    expect(spanFor(r)).toEqual({ first: 0, last: 1 });
    expect(sliceFor(0, r, SEG_PLAIN)).toEqual([SEG_PLAIN - 5, SEG_PLAIN]);
    expect(sliceFor(1, r, SEG_PLAIN)).toEqual([0, 5]);
  });
  test("whole file, short last segment", () => {
    const r = { start: 0, end: total - 1 };
    expect(spanFor(r)).toEqual({ first: 0, last: 2 });
    expect(sliceFor(2, r, 100)).toEqual([0, 100]);
    // bytes sliced across segments add up to the range length
    let n = 0;
    for (let s = 0; s <= 2; s++) { const [a, b] = sliceFor(s, r, s === 2 ? 100 : SEG_PLAIN); n += b - a; }
    expect(n).toBe(total);
  });
});

describe("playMime", () => {
  test("maps quicktime and unknown types to something browsers accept", () => {
    expect(playMime("video/quicktime", "IMG_1.MOV")).toBe("video/mp4");
    expect(playMime("", "clip.webm")).toBe("video/webm");
    expect(playMime("video/webm", "x")).toBe("video/webm");
  });
});
