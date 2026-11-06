// Switching models deletes the other model's files and keeps the shared ones (docs/SEARCH.md).
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
const store = vi.hoisted(() => ({ play: false }));
vi.mock("../store", () => ({ explicitSearchOffered: () => !store.play }));

const { downloadModels, dropOtherModels, MODELS } = await import("./models");
const all = () => MODELS.map((m) => `file:///docs/models/${m.name}`);

describe("dropOtherModels", () => {
  beforeEach(() => { files.clear(); for (const f of all()) files.add(f); files.add("file:///docs/models/nsfw-laion-b32-vision.onnx.part"); });

  it("going to LAION removes MobileCLIP's two files, keeps tokenizer and faces", () => {
    expect(dropOtherModels("laion-b32").sort()).toEqual(["mobileclip-s2-text.onnx", "mobileclip-s2-vision.onnx"]);
    const left = [...files].map((f) => f.split("/").pop());
    expect(left).toContain("mobileclip-s2-tokenizer.json");
    expect(left).toContain("yunet-2023mar.onnx");
    expect(left).toContain("sface-2021dec.onnx");
    expect(left).toContain("nsfw-laion-b32-vision.onnx");
  });

  it("going back to MobileCLIP removes LAION's 600 MB, a half download included", () => {
    expect(dropOtherModels("mobileclip-s2").sort()).toEqual(["nsfw-laion-b32-text.onnx", "nsfw-laion-b32-vision.onnx"]);
    expect([...files].some((f) => f.includes("nsfw-laion"))).toBe(false);
  });

  it("a phone that only searches keeps only the text model and the tokenizer", () => {
    expect(dropOtherModels("laion-b32", false).sort()).toEqual(["mobileclip-s2-text.onnx", "mobileclip-s2-vision.onnx", "nsfw-laion-b32-vision.onnx", "sface-2021dec.onnx", "yunet-2023mar.onnx"]);
    expect([...files].map((f) => f.split("/").pop()).sort()).toEqual(["mobileclip-s2-tokenizer.json", "nsfw-laion-b32-text.onnx"]);
  });
});

describe("where the models come from", () => {
  beforeEach(() => { files.clear(); fetched.length = 0; store.play = false; });

  it("every file has a role here and a URL pinned to a Hugging Face commit", () => {
    expect(MODELS).toHaveLength(7);
    for (const m of MODELS) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.faces || m.clip || m.text).toBeTruthy();
    }
  });

  it("downloads from the pinned URLs", async () => {
    await downloadModels(false, "mobileclip-s2", () => {});
    expect(fetched).toEqual(MODELS.filter((m) => !m.faces && m.clip !== "laion-b32").map((m) => m.url));
  });

  it("the Play build never downloads the explicit model", async () => {
    store.play = true;
    await expect(downloadModels(true, "laion-b32", () => {})).rejects.toThrow(/isn't available/);
    expect(fetched).toEqual([]);
    await downloadModels(false, "mobileclip-s2", () => {});
    expect(fetched.some((u) => u.includes("laion"))).toBe(false);
  });
});
