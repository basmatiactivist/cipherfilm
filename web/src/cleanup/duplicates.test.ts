import { describe, expect, it } from "vitest";
import { bytesOf, candidatePairs, chosenWith, cosine, exactGroups, findGroups, keepOrder, scoreWith, SIMILAR, similarCheck, similarGroupsFrom, suggested, type Candidate } from "./duplicates";

const MIN = 60_000;
let n = 0;
const item = (p: Partial<Candidate> = {}): Candidate => ({ id: `i${String(n++).padStart(6, "0")}`, ts: 1_700_000_000_000, name: `IMG_${n}.jpg`, size: 1000 + n, gps: false, uploaded: 1_700_000_000, image: true, ...p });

// a deterministic random source, so the synthetic vectors are the same on every run
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
}
const DIM = 512;
function unit(v: Float32Array) { let q = 0; for (const x of v) q += x * x; const l = Math.sqrt(q); return v.map((x) => x / l); }
const randomVec = (r: () => number) => unit(Float32Array.from({ length: DIM }, r));
/** a vector at exactly the given cosine to base (base a unit vector), in a random direction */
function at(base: Float32Array, cos: number, r: () => number): Float32Array {
  const o = randomVec(r);
  let d = 0; for (let i = 0; i < DIM; i++) d += o[i] * base[i];
  const perp = unit(o.map((x, i) => x - d * base[i]));
  const s = Math.sqrt(1 - cos * cos);
  return base.map((x, i) => cos * x + s * perp[i]);
}

describe("which to keep", () => {
  it("prefers resolution, then file size, then a location, then the earliest upload", () => {
    const big = item({ width: 4000, height: 3000, size: 10 });
    const small = item({ width: 2000, height: 1500, size: 99999 });
    expect([small, big].sort(keepOrder)[0]).toBe(big);
    const heavy = item({ width: 10, height: 10, size: 500 });
    const light = item({ width: 10, height: 10, size: 400 });
    expect([light, heavy].sort(keepOrder)[0]).toBe(heavy);
    const placed = item({ size: 1, gps: true, uploaded: 9 });
    const nowhere = item({ size: 1, gps: false, uploaded: 1 });
    expect([nowhere, placed].sort(keepOrder)[0]).toBe(placed);
    const first = item({ size: 1, uploaded: 5 });
    const later = item({ size: 1, uploaded: 6 });
    expect([later, first].sort(keepOrder)[0]).toBe(first);
    // no dimensions count as the lowest resolution
    const unknown = item({ size: 9e9 });
    expect([unknown, big].sort(keepOrder)[0]).toBe(big);
  });
  it("is the same whatever the order (id breaks a full tie)", () => {
    const a = item({ id: "a", size: 1 }), b = item({ id: "b", size: 1 });
    expect([b, a].sort(keepOrder)[0].id).toBe("a");
    expect([a, b].sort(keepOrder)[0].id).toBe("a");
  });
});

describe("exact duplicates", () => {
  it("groups the same name, size and capture time, the name in any case", () => {
    const a = item({ name: "IMG_1.JPG", size: 5000, ts: 1 });
    const b = item({ name: "img_1.jpg", size: 5000, ts: 1, gps: true });
    const c = item({ name: "IMG_1.JPG", size: 5000, ts: 1, uploaded: 1 });
    const g = exactGroups([a, b, c]);
    expect(g).toHaveLength(1);
    expect(g[0].kind).toBe("exact");
    expect(g[0].keep).toBe(b.id); // the one with a location
    expect(new Set(g[0].ids)).toEqual(new Set([a.id, b.id, c.id]));
  });
  it("doesn't group when the size or the capture time differs", () => {
    const base = { name: "x.jpg", size: 5000, ts: 1000 };
    expect(exactGroups([item(base), item({ ...base, size: 5001 })])).toEqual([]);
    expect(exactGroups([item(base), item({ ...base, ts: 1001 })])).toEqual([]);
  });
  it("groups older items by size and capture time whatever their names, when the pixel size agrees or isn't known", () => {
    const base = { size: 5000, ts: 1000 };
    // a copy saved as "IMG_1 (1).jpg", or the same photo uploaded from two devices under other names
    expect(exactGroups([item({ ...base, name: "IMG_1.jpg" }), item({ ...base, name: "IMG_1 (1).jpg" })])).toHaveLength(1);
    expect(exactGroups([item({ ...base, name: "a.jpg", width: 40, height: 30 }), item({ ...base, name: "b.jpg", width: 40, height: 30 })])).toHaveLength(1);
    // the turn applied on one device and not on the other
    expect(exactGroups([item({ ...base, name: "a.jpg", width: 40, height: 30 }), item({ ...base, name: "b.jpg", width: 30, height: 40 })])).toHaveLength(1);
    expect(exactGroups([item({ ...base, name: "a.jpg", width: 40, height: 30 }), item({ ...base, name: "b.jpg" })])).toHaveLength(1);
    // another pixel size under another name: not the same file
    expect(exactGroups([item({ ...base, name: "a.jpg", width: 40, height: 30 }), item({ ...base, name: "b.jpg", width: 80, height: 60 })])).toEqual([]);
    // the same name still counts, as before
    expect(exactGroups([item({ ...base, name: "a.jpg", width: 40, height: 30 }), item({ ...base, name: "A.JPG", width: 80, height: 60 })])).toHaveLength(1);
  });
  it("puts an item only where it matches every member without a hash (no chains)", () => {
    const base = { size: 5000, ts: 1000 };
    const a = item({ ...base, name: "a.jpg", width: 40, height: 30 });
    const open = item({ ...base, name: "b.jpg" }); // matches both a and c
    const c = item({ ...base, name: "c.jpg", width: 80, height: 60 });
    const g = exactGroups([a, open, c]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toHaveLength(2);
    expect(g[0].ids).toContain(open.id);
  });
});

describe("exact duplicates by the original's SHA-256", () => {
  const h = (c: string) => c.repeat(64);
  it("groups equal hashes whatever the names, times and sizes say", () => {
    const a = item({ name: "IMG_1.jpg", size: 5000, ts: 1, sha256: h("a") });
    const b = item({ name: "from-phone.jpg", size: 5000, ts: 99, sha256: h("a") }); // the date read differently
    const g = exactGroups([a, b, item({ sha256: h("b") })]);
    expect(g).toHaveLength(1);
    expect(new Set(g[0].ids)).toEqual(new Set([a.id, b.id]));
  });
  it("never groups different hashes, even with the same name, size and time", () => {
    const base = { name: "x.jpg", size: 5000, ts: 1000 };
    expect(exactGroups([item({ ...base, sha256: h("a") }), item({ ...base, sha256: h("b") })])).toEqual([]);
  });
  it("joins an older item without a hash to the matching hashed copies", () => {
    const base = { size: 5000, ts: 1000 };
    const x = item({ ...base, name: "a.jpg", sha256: h("c") }), y = item({ ...base, name: "b.jpg", sha256: h("c") });
    const old = item({ ...base, name: "old.jpg" });
    const g = exactGroups([old, x, y]);
    expect(g).toHaveLength(1);
    expect(new Set(g[0].ids)).toEqual(new Set([x.id, y.id, old.id]));
    // one hashed item and one old one: a pair
    expect(exactGroups([item({ ...base, name: "p.jpg", sha256: h("d") }), item({ ...base, name: "q.jpg" })])).toHaveLength(1);
  });
  it("puts an older item with only one of two different hashed files", () => {
    const base = { size: 5000, ts: 1000 };
    const g = exactGroups([item({ ...base, name: "a.jpg", sha256: h("1") }), item({ ...base, name: "b.jpg", sha256: h("2") }), item({ ...base, name: "c.jpg" })]);
    expect(g).toHaveLength(1);
    expect(g[0].ids).toHaveLength(2);
  });
  it("ignores a hash that isn't 64 lowercase hex characters", () => {
    const base = { name: "x.jpg", size: 5000, ts: 1000 };
    // taken as no hash: the name, size and time decide
    expect(exactGroups([item({ ...base, sha256: "nope" }), item({ ...base, sha256: h("A") })])).toHaveLength(1);
    expect(exactGroups([item({ ...base, sha256: "nope" }), item({ ...base, ts: 5, sha256: "nope" })])).toEqual([]);
  });
  it("leaves out empty files and items without a time", () => {
    expect(exactGroups([item({ name: "e", size: 0, ts: 1 }), item({ name: "e", size: 0, ts: 1 })])).toEqual([]);
    expect(exactGroups([item({ name: "e", size: 3, ts: NaN }), item({ name: "e", size: 3, ts: NaN })])).toEqual([]);
  });
  it("also finds videos and other files", () => {
    expect(exactGroups([item({ name: "v.mp4", size: 9, ts: 2, image: false }), item({ name: "v.mp4", size: 9, ts: 2, image: false })])).toHaveLength(1);
  });
  it("lists the newest first", () => {
    const old = [item({ name: "o", size: 1, ts: 10 }), item({ name: "o", size: 1, ts: 10 })];
    const fresh = [item({ name: "f", size: 1, ts: 20 }), item({ name: "f", size: 1, ts: 20 })];
    const g = exactGroups([...old, ...fresh]);
    expect(g).toHaveLength(2);
    expect(g[0].ids).toContain(fresh[0].id);
    expect(g[1].ids).toContain(old[0].id);
  });
});

describe("candidate pairs", () => {
  it("pairs only within the window, the edge included", () => {
    const s = [{ ts: 0 }, { ts: 5 * MIN }, { ts: 5 * MIN + 1 }, { ts: 20 * MIN }];
    const p = candidatePairs(s, 5 * MIN, 10);
    const got = Array.from(p.a, (a, k) => [a, p.b[k]]);
    expect(got).toEqual([[0, 1], [1, 2]]);
  });
  it("compares each with a limited number of later ones", () => {
    const s = Array.from({ length: 100 }, () => ({ ts: 0 }));
    const p = candidatePairs(s, MIN, 5);
    expect(p.a.length).toBe(95 * 5 + 4 + 3 + 2 + 1);
  });
});

describe("similar photos", () => {
  const r = rng(7);
  const base = randomVec(r);

  const run = async (items: Candidate[], vec: Map<string, Float32Array>, opts = {}) =>
    findGroups(items, (id) => vec.has(id), async (a, b) => scoreWith((id) => vec.get(id))(a, b), opts);

  it("groups very close vectors taken close in time, keeping the best", async () => {
    const vec = new Map<string, Float32Array>();
    const shots = [0, 1, 2].map((k) => item({ ts: k * 2000, width: 4000, height: 3000, size: 2_000_000 + k }));
    shots.forEach((s, k) => vec.set(s.id, k === 0 ? base : at(base, 0.97, r)));
    const other = item({ ts: 3000 });
    vec.set(other.id, randomVec(r));
    const f = await run([...shots, other], vec);
    expect(f.similar).toHaveLength(1);
    expect(new Set(f.similar[0].ids)).toEqual(new Set(shots.map((s) => s.id)));
    expect(f.similar[0].keep).toBe(shots[2].id); // the largest file
    expect(f.images).toBe(4);
    expect(f.indexed).toBe(4);
  });

  it("uses the threshold as the edge: at it counts, just below doesn't", () => {
    const sorted = [item({ ts: 0 }), item({ ts: 1 })];
    const p = candidatePairs(sorted);
    expect(similarGroupsFrom(sorted, p, [0.92], 0.92)).toHaveLength(1);
    expect(similarGroupsFrom(sorted, p, [0.9199], 0.92)).toHaveLength(0);
    expect(similarGroupsFrom(sorted, p, [NaN], 0.92)).toHaveLength(0);
  });

  it("uses the time window as the edge", async () => {
    const vec = new Map<string, Float32Array>();
    const a = item({ ts: 0 }), b = item({ ts: 5 * MIN }), c = item({ ts: 100 * MIN }), d = item({ ts: 105 * MIN + 1 });
    for (const x of [a, b, c, d]) vec.set(x.id, at(base, 0.999, r));
    const f = await run([a, b, c, d], vec);
    expect(f.similar.map((g) => new Set(g.ids))).toEqual([new Set([a.id, b.id])]);
  });

  it("never chains a slow series: every member is close to every other one", () => {
    // a-b and b-c are close, a-c is not: a and b group, c stays out
    const s = [item({ ts: 0 }), item({ ts: 1000 }), item({ ts: 2000 })];
    const p = candidatePairs(s); // pairs (0,1) (0,2) (1,2)
    const scores = [0.95, 0.85, 0.95];
    const g = similarGroupsFrom(s, p, scores, 0.92);
    expect(g).toHaveLength(1);
    expect(new Set(g[0].ids)).toEqual(new Set([s[0].id, s[1].id]));
  });

  it("joins the group it is closest to on its weakest pair", () => {
    const s = [item({ ts: 0 }), item({ ts: 1 }), item({ ts: 2 }), item({ ts: 3 })];
    // 0-1 group, 2 starts alone (not close to 0), then 3 is close to both groups; closer to {2}
    const p = candidatePairs(s); // (0,1)(0,2)(0,3)(1,2)(1,3)(2,3)
    const g = similarGroupsFrom(s, p, [0.95, 0.5, 0.93, 0.5, 0.93, 0.99], 0.92);
    expect(g.map((x) => new Set(x.ids))).toEqual(expect.arrayContaining([new Set([s[0].id, s[1].id]), new Set([s[2].id, s[3].id])]));
  });

  it("leaves out photos without a vector, videos, and the extra copies of exact duplicates", async () => {
    const vec = new Map<string, Float32Array>();
    const a = item({ ts: 0, name: "a", size: 10 }), copy = item({ ts: 0, name: "a", size: 10 });
    const b = item({ ts: 1000 }), noVec = item({ ts: 1500 }), video = item({ ts: 1200, image: false });
    for (const x of [a, copy, b, video]) vec.set(x.id, at(base, 0.999, r));
    const f = await run([a, copy, b, noVec, video], vec);
    expect(f.exact).toHaveLength(1);
    expect(f.similar).toHaveLength(1);
    const ids = f.similar[0].ids;
    expect(ids).toContain(b.id);
    expect(ids).toContain(f.exact[0].keep);
    expect(ids).not.toContain(f.exact[0].ids[1]);
    expect(ids).not.toContain(noVec.id);
    expect(ids).not.toContain(video.id);
    expect(f.images).toBe(3); // a's keeper, b, noVec
    expect(f.indexed).toBe(2);
  });

  it("finds only exact duplicates without a way to score", async () => {
    const a = item({ name: "z", size: 1, ts: 1 }), b = item({ name: "z", size: 1, ts: 1 });
    const f = await findGroups([a, b, item(), item()], () => true, null);
    expect(f.exact).toHaveLength(1);
    expect(f.similar).toEqual([]);
    expect(f.checked).toBe(4);
    expect(similarCheck(f, false)).toBe("off");
  });

  it("says how far the look for similar photos went", () => {
    expect(similarCheck({ images: 0, indexed: 0 }, false)).toBe("nothing");
    expect(similarCheck({ images: 0, indexed: 0 }, true)).toBe("nothing");
    expect(similarCheck({ images: 10, indexed: 10 }, false)).toBe("off");
    expect(similarCheck({ images: 10, indexed: 4 }, true)).toBe("partial");
    expect(similarCheck({ images: 10, indexed: 0 }, true)).toBe("partial");
    expect(similarCheck({ images: 10, indexed: 10 }, true)).toBe("complete");
  });

  it("asks for scores in batches", async () => {
    const items = Array.from({ length: 3000 }, (_, k) => item({ ts: Math.floor(k / 10) * 1000 }));
    const sizes: number[] = [];
    await findGroups(items, () => true, async (a) => { sizes.push(a.length); return new Float32Array(a.length); });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4096);
    expect(sizes.length).toBeGreaterThan(1);
  });
});

describe("selection", () => {
  it("suggests all but the one to keep, and adds up their size", () => {
    const g = [{ kind: "exact" as const, ids: ["k", "x", "y"], keep: "k" }, { kind: "similar" as const, ids: ["k2", "z"], keep: "k2" }];
    const s = suggested(g);
    expect([...s].sort()).toEqual(["x", "y", "z"]);
    expect(bytesOf(s, (id) => ({ x: 1, y: 2, z: 4 } as Record<string, number>)[id])).toBe(7);
  });
  it("keeps the person's changes over the suggestion, for the groups that are still there", () => {
    const g = [{ kind: "exact" as const, ids: ["k", "x", "y"], keep: "k" }];
    const changed = new Map([["k", true], ["x", false], ["gone", true]]);
    expect([...chosenWith(g, changed)].sort()).toEqual(["k", "y"]);
    expect([...chosenWith(g, new Map())].sort()).toEqual(["x", "y"]);
  });
  it("computes the cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 2])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1], [1, 0])).toBeNaN();
  });
});

describe("a large library", () => {
  it("groups 50,000 photos quickly, finding the planted bursts and duplicates", async () => {
    const r = rng(42);
    const N = 50_000;
    const items: Candidate[] = [];
    const vec = new Map<string, Float32Array>();
    const t0 = 1_500_000_000_000;
    // spread over five years, with 500 bursts of 4 shots a second apart and 200 photos uploaded twice
    for (let k = 0; k < N - 2000 - 200; k++) {
      const c = item({ ts: t0 + Math.floor((r() + 0.5) * 5 * 365 * 86400_000) });
      items.push(c); vec.set(c.id, randomVec(r));
    }
    for (let b = 0; b < 500; b++) {
      const start = t0 + Math.floor((r() + 0.5) * 5 * 365 * 86400_000), first = randomVec(r);
      for (let k = 0; k < 4; k++) { const c = item({ ts: start + k * 1000 }); items.push(c); vec.set(c.id, k ? at(first, 0.97, r) : first); }
    }
    for (let d = 0; d < 200; d++) {
      const c = items[d * 7];
      const twin = { ...c, id: `dup${d}` };
      items.push(twin); vec.set(twin.id, vec.get(c.id)!);
    }
    expect(items).toHaveLength(N);
    const scored = { n: 0 };
    const score = scoreWith((id) => vec.get(id));
    const started = performance.now();
    const f = await findGroups(items, (id) => vec.has(id), async (a, b) => { scored.n += a.length; return score(a, b); });
    const ms = performance.now() - started;
    expect(f.exact).toHaveLength(200);
    expect(f.similar.length).toBeGreaterThanOrEqual(500);
    expect(f.similar.filter((g) => g.ids.length === 4).length).toBeGreaterThanOrEqual(495);
    // bounded by the window, not by n²: far below the 1.25 billion pairs of comparing everything
    expect(scored.n).toBeLessThan(N * SIMILAR.neighbours);
    expect(ms).toBeLessThan(5000);
  }, 30_000);

  it("stays bounded when everything was taken at the same moment", () => {
    const s = Array.from({ length: 50_000 }, () => ({ ts: 0 }));
    const started = performance.now();
    const p = candidatePairs(s);
    expect(p.a.length).toBeLessThanOrEqual(50_000 * SIMILAR.neighbours);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
