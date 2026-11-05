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
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));

const { dropOtherModels, MODELS } = await import("./models");
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
