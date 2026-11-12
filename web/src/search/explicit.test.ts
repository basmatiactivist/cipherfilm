// @ts-nocheck: runs in Node (vitest)
// The explicit-content filter (docs/SEARCH.md, "Explicit content"): the concepts from server/explicit-filter.json, the
// two thresholds, filtered search (photos left out, explicit words find nothing) and when it doesn't filter.
import { describe, expect, it } from "vitest";
import FILTER from "../../../server/explicit-filter.json";
import { explicitScore, halfs, imageHidden, IMAGE_THRESHOLD, queryBlocked, QUERY_THRESHOLD, searchHits, unfiltered } from "./explicit";
import { normalize } from "./rank";

/** a concept's own vector, decoded like the module does (a text vector stands in for an image or query vector here) */
function vec(text: string): Float32Array {
  const c = FILTER.concepts.find((x) => x.text === text);
  if (!c) throw new Error(text);
  const s = c.vec.replace(/-/g, "+").replace(/_/g, "/");
  return normalize(halfs(Uint8Array.from(Buffer.from(s, "base64"))));
}
const mix = (a: Float32Array, b: Float32Array, t: number) => normalize(a.map((x, i) => (1 - t) * x + t * b[i]));

describe("explicit-content filter", () => {
  it("has the concepts and thresholds the script wrote, for this model", () => {
    expect(FILTER.model).toBe("48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722"); // clip-b32-text.onnx
    expect(IMAGE_THRESHOLD).toBe(0.01);
    expect(QUERY_THRESHOLD).toBe(0.03);
    const img = FILTER.concepts.filter((c) => c.image);
    expect(img.some((c) => c.explicit) && img.some((c) => !c.explicit)).toBe(true);
    for (const c of FILTER.concepts) {
      const v = halfs(Uint8Array.from(Buffer.from(c.vec.replace(/-/g, "+").replace(/_/g, "/"), "base64")));
      expect(v.length, c.text).toBe(512);
      expect(Math.hypot(...v), c.text).toBeCloseTo(1, 2);
    }
  });

  it("reads float16 as the index entries store it", () => {
    expect(Array.from(halfs(Uint8Array.from([0x00, 0x3c, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x38, 0x01, 0x00])))).toEqual([1, -2, 0, 0.5, 2 ** -24]);
  });

  it("hides an image that looks like an explicit concept, not one that looks like a neutral one", () => {
    expect(imageHidden(vec("a photo of a naked person"))).toBe(true);
    expect(imageHidden(vec("pornography"))).toBe(true);
    for (const t of ["a photo of a person", "a photo of people at the beach", "a landscape photo", "a screenshot", "a photo of a baby"]) {
      expect(imageHidden(vec(t)), t).toBe(false);
    }
    // the score is the margin of the closest explicit concept over the closest neutral one; the threshold sits on it
    const a = vec("a photo of a naked person"), b = vec("a photo of a person");
    let lo = 0, hi = 1;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (imageHidden(mix(a, b, m))) lo = m; else hi = m; }
    expect(explicitScore(mix(a, b, lo), true)).toBeGreaterThanOrEqual(IMAGE_THRESHOLD);
    expect(explicitScore(mix(a, b, hi), true)).toBeLessThan(IMAGE_THRESHOLD);
    // scale doesn't matter; a vector of another model (length) is never hidden
    expect(imageHidden(a.map((x) => x * 3))).toBe(true);
    expect(imageHidden(new Float32Array(256).fill(0.1))).toBe(false);
  });

  it("blocks explicit search words, not everyday ones", () => {
    for (const t of ["nude", "porn", "nackt", "a photo of genitals"]) expect(queryBlocked(vec(t)), t).toBe(true);
    for (const t of ["beach", "dog", "swimsuit", "bikini", "baby", "bath", "statue", "a family photo"]) expect(queryBlocked(vec(t)), t).toBe(false);
    expect(explicitScore(vec("beach"), false)).toBeLessThan(QUERY_THRESHOLD);
  });

  it("filtered search leaves out hidden photos and finds nothing for explicit words; unfiltered finds everything", () => {
    const vectors = new Map([["beach", vec("a photo of people at the beach")], ["x", vec("a photo of a naked person")], ["dog", vec("a photo of an animal")]]);
    const hidden = new Set([...vectors].filter(([, v]) => imageHidden(v)).map(([id]) => id));
    expect([...hidden]).toEqual(["x"]);
    const q = vec("beach");
    expect(searchHits(q, vectors, hidden, true).map((h) => h.id)).toEqual(["beach", "dog"]);
    expect(searchHits(q, vectors, hidden, false).map((h) => h.id).sort()).toEqual(["beach", "dog", "x"]);
    expect(searchHits(vec("nude"), vectors, hidden, true)).toEqual([]);
    expect(searchHits(vec("nude"), vectors, hidden, false)).toHaveLength(3);
  });

  it("filters unless an admin allowed explicit search, the person chose it and the app offers it (never Google Play's)", () => {
    expect(unfiltered({ allowed: true, chosen: true })).toBe(true);
    expect(unfiltered({ allowed: true, chosen: true, offered: true })).toBe(true);
    expect(unfiltered({ allowed: true, chosen: true, offered: false })).toBe(false); // the Play build
    expect(unfiltered({ allowed: false, chosen: true })).toBe(false); // the admin withdrew it
    expect(unfiltered({ allowed: true, chosen: false })).toBe(false);
  });
});
