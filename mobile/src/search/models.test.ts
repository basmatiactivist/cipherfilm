// One model for everyone (docs/SEARCH.md "One model"): which files a phone needs, where they come from, and what
// becomes of the files earlier versions downloaded.
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Set<string>();
vi.mock("expo-file-system", () => {
  class Directory { uri: string; constructor(_a: unknown, name: string) { this.uri = `file:///docs/${name}`; } get exists() { return true; } create() {} delete() {} }
  class File {
    path: string;
    constructor(dir: { uri: string }, name: string) { this.path = `${dir.uri}/${name}`; }
    get uri() { return this.path; }
    get exists() { return files.has(this.path); }
    delete() { files.delete(this.path); }
    moveSync(to: File) { files.delete(this.path); files.add(to.path); }
  }
  return { Directory, File, Paths: { document: "docs" } };
});
const fetched: string[] = [];
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    addListener: () => ({ remove() {} }),
    downloadModel: async (url: string) => { fetched.push(url); return true; },
  },
}));

const load = async () => { vi.resetModules(); return import("./models"); };
const { agreeModels, CLIP, downloadModels, downloadSize, dropOtherModels, MODELS, needed, toCompute } = await load();
const dir = "file:///docs/models/";
const here = () => [...files].map((f) => f.replace(dir, "")).sort();
const names = (l: { name: string }[]) => l.map((m) => m.name).sort();

describe("the files", () => {
  beforeEach(() => { files.clear(); fetched.length = 0; });

  it("are LAION's ViT-B/32 (Immich's export), its tokenizer and the face models, each pinned to a Hugging Face commit", () => {
    expect(names(MODELS)).toEqual(["clip-b32-text.onnx", "clip-b32-tokenizer.json", "clip-b32-vision.onnx", "sface-2021dec.onnx", "yunet-2023mar.onnx"]);
    for (const m of MODELS) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//);
      expect(m.url).not.toMatch(/mobileclip/i);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.faces || m.clip || m.text).toBeTruthy();
    }
  });

  it("a phone that indexes needs everything (faces only with faces on), one that only searches the text side", () => {
    expect(names(needed(true, CLIP))).toEqual(names(MODELS));
    expect(names(needed(false, CLIP))).toEqual(["clip-b32-text.onnx", "clip-b32-tokenizer.json", "clip-b32-vision.onnx"]);
    expect(names(needed(true, CLIP, false))).toEqual(["clip-b32-text.onnx", "clip-b32-tokenizer.json"]);
  });

  it("downloads from the pinned URLs, in the Play build too (one model for every build)", async () => {
    agreeModels(false, CLIP);
    await downloadModels(false, CLIP, () => {});
    expect(fetched).toEqual(MODELS.filter((m) => !m.faces).map((m) => m.url));
  });

  it("counts what is missing", () => {
    const size = (n: string) => MODELS.find((m) => m.name === n)!.size;
    expect(downloadSize(false, CLIP, false)).toBe(size("clip-b32-text.onnx") + size("clip-b32-tokenizer.json"));
    files.add(`${dir}clip-b32-text.onnx`);
    expect(downloadSize(false, CLIP, false)).toBe(size("clip-b32-tokenizer.json"));
  });

  it("an item is done when its entry is the model's (explicit search's LAION entries are), with faces when they are on", () => {
    expect(toCompute("laionb32+yunet23+sface21/1", true)).toEqual([]);
    expect(toCompute("laionb32/1", false)).toEqual([]);
    expect(toCompute("laionb32/1", true)).toEqual([CLIP]);
    expect(toCompute("mcs2+yunet23+sface21/2", true)).toEqual([CLIP]); // MobileCLIP's, from before: made again
    expect(toCompute(undefined, false)).toEqual([CLIP]);
  });
});

describe("files of earlier versions", () => {
  beforeEach(() => { files.clear(); fetched.length = 0; });

  it("explicit search's LAION files are moved to the new names (not downloaded again), MobileCLIP's are deleted", async () => {
    for (const n of ["nsfw-laion-b32-vision.onnx", "nsfw-laion-b32-text.onnx", "mobileclip-s2-vision.onnx", "mobileclip-s2-text.onnx", "mobileclip-s2-tokenizer.json", "mobileclip-s2-vision.onnx.part", "yunet-2023mar.onnx"]) files.add(dir + n);
    const m = await load();
    const size = (n: string) => m.MODELS.find((x) => x.name === n)!.size;
    expect(m.downloadSize(false, m.CLIP)).toBe(size("clip-b32-tokenizer.json")); // only the new tokenizer is missing
    expect(here()).toEqual(["clip-b32-text.onnx", "clip-b32-vision.onnx", "yunet-2023mar.onnx"]);
  });

  it("a half download of the old name goes; a file already under the new name wins", async () => {
    for (const n of ["nsfw-laion-b32-text.onnx", "nsfw-laion-b32-vision.onnx.part", "clip-b32-text.onnx"]) files.add(dir + n);
    const m = await load();
    m.tidyOldFiles();
    expect(here()).toEqual(["clip-b32-text.onnx"]);
  });
});

describe("dropOtherModels", () => {
  beforeEach(() => { files.clear(); for (const m of MODELS) files.add(dir + m.name); });

  it("a phone that indexes keeps everything", () => {
    expect(dropOtherModels(CLIP)).toEqual([]);
    expect(here()).toEqual(names(MODELS));
  });

  it("a phone that only searches keeps only the text model and the tokenizer", () => {
    expect(dropOtherModels(CLIP, false).sort()).toEqual(["clip-b32-vision.onnx", "sface-2021dec.onnx", "yunet-2023mar.onnx"]);
    expect(here()).toEqual(["clip-b32-text.onnx", "clip-b32-tokenizer.json"]);
  });
});
