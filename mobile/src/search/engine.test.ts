import { describe, expect, it, vi } from "vitest";

// A picture the native side can't use gets an empty entry once, instead of failing again at every start.
const nat = vi.hoisted(() => ({ analyze: async (..._a: unknown[]): Promise<unknown> => ({}) }));
vi.mock("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: { visionAnalyze: (...a: unknown[]) => nat.analyze(...a) } }));
vi.mock("../api", () => ({ api: async () => ({}), ApiError: class extends Error {}, server: () => "" }));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../session", () => ({ onWipe: () => {}, refreshMe: async () => null, session: () => ({}) }));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(0) }));
vi.mock("../keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./settings", () => ({ loadSettings: async () => ({}), saveSettings: async () => {}, settingsDir: () => ({}) }));
vi.mock("./models", () => ({ modelTag: (c: string, f: boolean) => `${c}/${f ? "faces" : "plain"}`, family: (c: string) => c, CLIP: "clip-b32" }));

const { analyzeBytes } = await import("./engine");

describe("analyzeBytes", () => {
  it("stores an empty entry for an unusable picture, and wipes the bytes", async () => {
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await analyzeBytes(bytes, true, ["clip-b32"])).toEqual([{ v: 1, m: "clip-b32/faces", faces: [] }]);
    expect(await analyzeBytes(new Uint8Array(1), false, ["clip-b32"])).toEqual([{ v: 1, m: "clip-b32/plain" }]);
    expect([...bytes]).toEqual([0, 0, 0]);
  });

  it("passes other failures on, so they are tried again", async () => {
    nat.analyze = async () => { throw new Error("search models not loaded"); };
    await expect(analyzeBytes(new Uint8Array(1), false, ["clip-b32"])).rejects.toThrow(/not loaded/);
  });

  it("turns an analysis into an entry", async () => {
    nat.analyze = async () => ({ clips: [new Uint8Array([1, 2])] });
    const [e] = await analyzeBytes(new Uint8Array(1), false, ["clip-b32"]);
    expect(e.m).toBe("clip-b32/plain");
    expect(typeof e.clip).toBe("string");
  });

  it("with the faces given (from the item's MobileCLIP entry, made before one model) doesn't look for them again", async () => {
    const asked: unknown[][] = [];
    nat.analyze = async (...a: unknown[]) => { asked.push(a.slice(1)); return { clips: [new Uint8Array([1, 2])] }; };
    const known = [{ box: [0.1, 0.1, 0.2, 0.2], score: 0.95, emb: "AAAA" }];
    const [e] = await analyzeBytes(new Uint8Array(1), true, ["clip-b32"], known);
    expect(asked).toEqual([[false, ["clip-b32"]]]);
    expect(e).toMatchObject({ m: "clip-b32/faces", faces: known });
    // an unusable picture keeps them too
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    expect(await analyzeBytes(new Uint8Array(1), true, ["clip-b32"], known)).toEqual([{ v: 1, m: "clip-b32/faces", faces: known }]);
  });
});
