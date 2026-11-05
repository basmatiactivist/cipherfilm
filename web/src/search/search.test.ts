// @ts-nocheck: runs in Node (vitest), where the app's types have no node:fs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cosine, familyOf, normalize, padIds, rank, TEXT_MODELS, TOKENIZER } from "./rank";
import { splitQuery } from "../search";
import reference from "./reference.json";

const unit = (v: number[]) => normalize(Float32Array.from(v));

describe("search by content: ranking", () => {
  it("reads the model from the index entry's tag", () => {
    expect(familyOf("mcs2+yunet23+sface21/2")).toBe("mcs2");
    expect(familyOf("mcs2/2")).toBe("mcs2");
    expect(familyOf("laionb32+yunet23+sface21/1")).toBe("laionb32");
    expect(familyOf("laionb32/1")).toBe("laionb32");
    expect(familyOf("webqa-synthetic")).toBeUndefined();
    expect(familyOf(undefined)).toBeUndefined();
  });

  it("pads ids with 0 to 77 and cuts longer ones", () => {
    expect(padIds([49406, 1929, 49407])).toEqual([49406, 1929, 49407, ...new Array(74).fill(0)]);
    expect(padIds(new Array(90).fill(5))).toHaveLength(77);
  });

  it("ranks every vector best first and cuts nothing off, like Immich", () => {
    const q = unit([1, 0, 0]);
    const v = new Map([
      ["low", unit([0.1, 1, 0])],
      ["best", unit([0.9, 0.1, 0])],
      ["mid", unit([0.5, 0.5, 0])],
      ["opposite", unit([-1, 0, 0])],
      ["other model", unit([1, 0])], // a vector of another length is never compared
    ]);
    const hits = rank(q, v);
    expect(hits.map((h) => h.id)).toEqual(["best", "mid", "low", "opposite"]);
    expect(hits[0].score).toBeCloseTo(cosine(q, unit([0.9, 0.1, 0])), 6);
    expect(rank(q, new Map())).toEqual([]);
  });

  it("splits a query into metadata words and words about what is in the photo", () => {
    expect(splitQuery("Anna beach 2023", ["Anna Muster"])).toEqual({ filters: ["anna", "2023"], content: "beach" });
    expect(splitQuery("birthday cake march videos")).toEqual({ filters: ["march", "videos"], content: "birthday cake" });
    expect(splitQuery("dog on the beach")).toEqual({ filters: [], content: "dog on the beach" });
    expect(splitQuery("14.03.2023 favorites")).toEqual({ filters: ["14.03.2023", "favorites"], content: "" });
  });
});

// The browser's text vector (this tokenizer and ONNX Runtime Web, as in content.worker.ts) against the Python reference
// (onnxruntime 1.31.1 and Hugging Face's tokenizers on the same files). The models are 64 and 254 MB and not in the
// repository: set CF_MODELS to a folder with them (from the server image's /models) to run this.
const dir = process.env.CF_MODELS;
const have = (f: string) => !!dir && existsSync(join(dir, f));

describe("search by content: text vectors match the reference", () => {
  for (const m of Object.values(TEXT_MODELS)) {
    // LAION's fp32 model gives the reference's numbers; MobileCLIP's int8 one differs a little between ONNX Runtime's
    // WebAssembly and x86 int8 kernels (0.998 to 1 measured), far less than the 0.09 the ranking works with
    const min = m.family === "laionb32" ? 0.9999 : 0.997;
    it.skipIf(!have(m.file) || !have(TOKENIZER.file))(`${m.file}: same ids and cosine ≥ ${min}`, async () => {
      const ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.numThreads = 1;
      const { Tokenizer } = await import("./tokenizer");
      const { embed } = await import("./embed");
      const tok = new Tokenizer(JSON.parse(readFileSync(join(dir!, TOKENIZER.file), "utf8")));
      const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(dir!, m.file))), { executionProviders: ["wasm"] });
      for (const [q, r] of Object.entries(reference.queries)) {
        expect(tok.encode(q), q).toEqual(r.ids);
        const v = await embed(s, tok, q, m.int32);
        const c = cosine(v, Float32Array.from(m.family === "mcs2" ? r.mobileclip : r.laion));
        expect(c, `${q}: ${c}`).toBeGreaterThanOrEqual(min);
      }
      await s.release();
    }, 120_000);
  }
});
