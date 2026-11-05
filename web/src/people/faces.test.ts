import { describe, expect, it } from "vitest";
import { FaceIndex, unhalf } from "./faces";

// float16 little-endian, exact for 0 and powers of two
const half = (v: number[]) => {
  const out = new Uint8Array(v.length * 2);
  v.forEach((x, i) => {
    const h = x === 0 ? 0 : (x < 0 ? 0x8000 : 0) | ((Math.log2(Math.abs(x)) + 15) << 10);
    out[2 * i] = h & 0xff; out[2 * i + 1] = h >> 8;
  });
  return out;
};
const face = (i: number, box = [0.1, 0.1, 0.2, 0.2], score = 0.9) => { const v = new Array(128).fill(0); v[i] = 1; return { box, score, emb: half(v) }; };

describe("float16", () => {
  it("decodes like Vision.unhalf", () => {
    expect([...unhalf(new Uint8Array([0x00, 0x3c, 0x00, 0xbc, 0x00, 0x38, 0x00, 0x00, 0xff, 0x7b, 0x55, 0x35]))])
      .toEqual([1, -1, 0.5, 0, 65504, Math.fround(0.333251953125)]);
    expect(unhalf(new Uint8Array([0x01, 0x00]))[0]).toBeCloseTo(2 ** -24, 30); // subnormal
  });
});

describe("cluster: the same groups as SearchTests.indexAndClusters (Mac) and SearchIndex.kt", () => {
  const idx = new FaceIndex();
  for (let i = 0; i < 4; i++) idx.put(`p${i}`, [face(3)]);

  it("anchors name the group, rejects leave it", () => {
    const g = idx.cluster(0.5, [["anna", ["p0:0"]]], { anna: ["p3:0"] }, 3);
    expect(g.length).toBe(1);
    expect(g[0].person).toBe("anna");
    expect(g[0].items).toEqual(["p0", "p1", "p2"]);
  });

  it("a face given to someone else shows under them, even though it groups with Anna's", () => {
    const m = idx.cluster(0.5, [["anna", ["p0:0"]], ["ben", ["p2:0"]]], { anna: ["p2:0"] }, 3);
    expect(m.find((g) => g.person === "anna")?.items).toEqual(["p0", "p1", "p3"]);
    expect(m.find((g) => g.person === "ben")?.items).toEqual(["p2"]);
  });

  it("keeps different people apart, leaves out small or unclear faces, joins a person's groups", () => {
    const x = new FaceIndex();
    for (let i = 0; i < 3; i++) x.put(`a${i}`, [face(1), face(2)]);
    x.put("small", [face(1, [0.1, 0.1, 0.03, 0.03])]);
    x.put("blurry", [face(1, undefined, 0.5)]);
    x.put("c0", [face(7)]);
    const all = x.cluster(0.5, [], {}, 1);
    expect(all.map((g) => g.items)).toEqual([["a0", "a1", "a2"], ["a0", "a1", "a2"], ["c0"]]);
    expect(all[0].faces).toEqual(["a0:0", "a1:0", "a2:0"]);
    expect(all[0].cover).toEqual({ key: "a0:0", item: "a0", box: [0.1, 0.1, 0.2, 0.2] });
    expect(x.cluster(0.5, [], {}, 3).length).toBe(2);
    // naming faces of two groups as one person joins them
    const one = x.cluster(0.5, [["p", ["a0:0", "a1:1"]]], {}, 3);
    expect(one.length).toBe(1);
    expect(one[0].faces.length).toBe(6);
    expect(x.facesOf("a1").map((f) => f.key)).toEqual(["a1:0", "a1:1"]);
    x.remove("a1");
    expect(x.facesOf("a1")).toEqual([]);
    expect(x.cluster(0.5, [], {}, 1)[0].items).toEqual(["a0", "a2"]);
  });
});
