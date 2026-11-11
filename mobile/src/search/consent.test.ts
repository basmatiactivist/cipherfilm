// Nothing is downloaded from Hugging Face before the person agreed (docs/MODELS.md): the gate in models.ts, which
// every download goes through; the yes is kept on the phone, covers exactly the files agreed to, and goes with the
// models when search is turned off.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ files: new Map<string, { text: string; mtime: number }>(), good: new Set<string>() }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(_a: unknown, name: string) { this.uri = `file:///docs/${name}`; }
    get exists() { return [...fs.files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    delete() { for (const k of [...fs.files.keys()]) if (k.startsWith(this.uri + "/")) fs.files.delete(k); }
  }
  class File {
    uri: string;
    constructor(dir: { uri: string }, name: string) { this.uri = `${dir.uri}/${name}`; }
    get exists() { return fs.files.has(this.uri); }
    get modificationTime() { return fs.files.get(this.uri)?.mtime ?? null; }
    textSync() { return fs.files.get(this.uri)!.text; }
    write(s: string) { fs.files.set(this.uri, { text: s, mtime: Date.now() }); }
    delete() { fs.files.delete(this.uri); }
  }
  return { Directory, File, Paths: { document: "docs" } };
});
const fetched: string[] = [];
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    addListener: () => ({ remove() {} }),
    downloadModel: async (url: string, path: string) => { fetched.push(url); fs.files.set(`file://${path}`, { text: "", mtime: 1 }); return true; },
    checkModel: async (path: string) => fs.good.has(path.split("/").pop()!),
    visionClose: () => {},
  },
}));
vi.mock("../store", () => ({ explicitSearchOffered: () => true }));

const load = async () => { vi.resetModules(); return import("./models"); };
const at = (name: string) => `file:///docs/models/${name}`;
const CONSENT = at("consent.json");

beforeEach(() => { fs.files.clear(); fs.good.clear(); fetched.length = 0; });

describe("asking before the models are downloaded (Android)", () => {
  it("without a yes, no download starts, whatever asks for it", async () => {
    const m = await load();
    await expect(m.downloadModels(true, "mobileclip-s2", () => {})).rejects.toBeInstanceOf(m.NeedsConsent);
    await expect(m.downloadModels(false, "laion-b32", () => {}, false)).rejects.toBeInstanceOf(m.NeedsConsent);
    expect(fetched).toEqual([]);
    expect(m.unagreed(true, "mobileclip-s2").length).toBe(5);
  });

  it("the yes is kept on the phone (also after a restart) and lets exactly those files download", async () => {
    let m = await load();
    m.agreeModels(false, "mobileclip-s2");
    const saved = JSON.parse(fs.files.get(CONSENT)!.text);
    expect(saved.at).toBeGreaterThan(0);
    expect(saved.sha.sort()).toEqual(m.needed(false, "mobileclip-s2").map((x) => x.sha256).sort());
    m = await load(); // the app started again
    expect(m.unagreed(false, "mobileclip-s2")).toEqual([]);
    // faces and explicit search need other files: asked again
    expect(m.unagreed(true, "mobileclip-s2").map((x) => x.name).sort()).toEqual(["sface-2021dec.onnx", "yunet-2023mar.onnx"]);
    await expect(m.downloadModels(true, "mobileclip-s2", () => {})).rejects.toBeInstanceOf(m.NeedsConsent);
    expect(fetched).toEqual([]);
    await m.downloadModels(false, "mobileclip-s2", () => {});
    expect(fetched.length).toBe(3);
  });

  it("a model update (another SHA-256) asks again", async () => {
    const m = await load();
    fs.files.set(CONSENT, { text: JSON.stringify({ at: 5, sha: m.needed(false, "mobileclip-s2").map((x) => (x.name.includes("vision") ? "0".repeat(64) : x.sha256)) }), mtime: 5 });
    const again = await load();
    expect(again.unagreed(false, "mobileclip-s2").map((x) => x.name)).toEqual(["mobileclip-s2-vision.onnx"]);
  });

  it("models downloaded before this question existed: no question, and the settings say when", async () => {
    const m = await load();
    for (const x of m.needed(false, "mobileclip-s2")) { fs.files.set(at(x.name), { text: "", mtime: 1_700_000_000_000 }); fs.good.add(x.name); }
    expect(m.unagreed(false, "mobileclip-s2")).toEqual([]);
    await m.downloadModels(false, "mobileclip-s2", () => {}); // all here with the right hash: nothing fetched, no question
    expect(fetched).toEqual([]);
    expect(m.modelsOnPhone()).toEqual({ at: 1_700_000_000_000, bytes: m.needed(false, "mobileclip-s2").reduce((n, x) => n + x.size, 0) });
    expect(JSON.parse(fs.files.get(CONSENT)!.text).at).toBe(1_700_000_000_000);
  });

  it("a file here with the wrong hash is not a yes", async () => {
    const m = await load();
    fs.files.set(at("mobileclip-s2-text.onnx"), { text: "", mtime: 1 });
    await expect(m.downloadModels(false, "mobileclip-s2", () => {}, false)).rejects.toBeInstanceOf(m.NeedsConsent);
    expect(fetched).toEqual([]);
  });

  it("turning search off deletes the models and withdraws the yes", async () => {
    let m = await load();
    m.agreeModels(true, "mobileclip-s2");
    await m.downloadModels(true, "mobileclip-s2", () => {});
    m.deleteModels();
    expect(fs.files.size).toBe(0);
    expect(m.modelsOnPhone()).toBeNull();
    m = await load();
    expect(m.unagreed(true, "mobileclip-s2").length).toBe(5);
  });

  it("switching models: the files that go are asked for again", async () => {
    const m = await load();
    m.agreeModels(false, "mobileclip-s2", false);
    m.agreeModels(false, "laion-b32", false);
    await m.downloadModels(false, "laion-b32", () => {}, false);
    expect(m.dropOtherModels("mobileclip-s2", false)).toContain("nsfw-laion-b32-text.onnx"); // back to standard
    expect(m.unagreed(false, "mobileclip-s2", false)).toEqual([]);
    expect(m.unagreed(false, "laion-b32", false).map((x) => x.name)).toEqual(["nsfw-laion-b32-text.onnx"]);
  });
});
