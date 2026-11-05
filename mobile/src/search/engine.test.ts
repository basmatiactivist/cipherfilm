import { describe, expect, it, vi } from "vitest";

// A picture the native side can't use gets an empty entry once, instead of failing again at every start.
const nat = vi.hoisted(() => ({ analyze: async (): Promise<unknown> => ({}) }));
vi.mock("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: { visionAnalyze: () => nat.analyze() } }));
vi.mock("../api", () => ({ api: async () => ({}), ApiError: class extends Error {}, server: () => "" }));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../session", () => ({ onWipe: () => {}, refreshMe: async () => null, session: () => ({}) }));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(0) }));
vi.mock("../keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./settings", () => ({ loadSettings: async () => ({}), saveSettings: async () => {}, settingsDir: () => ({}) }));
vi.mock("./models", () => ({ modelTag: (c: string, f: boolean) => `${c}/${f ? "faces" : "plain"}`, family: (c: string) => c }));

const { analyzeBytes } = await import("./engine");

describe("analyzeBytes", () => {
  it("stores an empty entry for an unusable picture, and wipes the bytes", async () => {
    nat.analyze = async () => { throw Object.assign(new Error("not a usable picture"), { code: "ERR_UNUSABLE_IMAGE" }); };
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await analyzeBytes(bytes, true, "mobileclip-s2")).toEqual({ v: 1, m: "mobileclip-s2/faces", faces: [] });
    expect(await analyzeBytes(new Uint8Array(1), false, "laion-b32")).toEqual({ v: 1, m: "laion-b32/plain" });
    expect([...bytes]).toEqual([0, 0, 0]);
  });

  it("passes other failures on, so they are tried again", async () => {
    nat.analyze = async () => { throw new Error("search models not loaded"); };
    await expect(analyzeBytes(new Uint8Array(1), false, "mobileclip-s2")).rejects.toThrow(/not loaded/);
  });

  it("turns an analysis into an entry", async () => {
    nat.analyze = async () => ({ clip: new Uint8Array([1, 2]) });
    const e = await analyzeBytes(new Uint8Array(1), false, "mobileclip-s2");
    expect(e.m).toBe("mobileclip-s2/plain");
    expect(typeof e.clip).toBe("string");
  });
});
