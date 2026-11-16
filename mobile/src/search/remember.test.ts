import { describe, expect, it, vi } from "vitest";

// What the background indexer may match to a phone file by name and size: only items this phone uploaded itself.
const st = vi.hoisted(() => ({ written: "", own: new Set<string>() }));
vi.mock("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("../api", () => ({ api: async () => ({}), ApiError: class extends Error {}, server: () => "" }));
vi.mock("../session", () => ({ onWipe: () => {}, refreshMe: async () => null, session: () => ({ me: { user: { id: "u1" } } }) }));
vi.mock("../ownUploads", () => ({
  onlyOwn: async (userId: string | undefined, items: { id: string }[]) => (userId === "u1" ? items.filter((it) => st.own.has(it.id)) : []),
}));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(0) }));
vi.mock("../keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./settings", () => ({
  loadSettings: async () => ({}), saveSettings: async () => {},
  settingsDir: () => ({ create: () => {} }),
}));
vi.mock("./models", () => ({ modelTag: (c: string, f: boolean) => `${c}/${f ? "faces" : "plain"}`, family: (c: string) => c, CLIP: "clip-b32" }));

const engine = await import("./engine");
const { fingerprint } = await import("../prints");

describe("the list for the background", () => {
  it("names only this phone's own uploads by name and size", async () => {
    const File = (await import("expo-file-system")).File as unknown as { prototype: { write: (v: string) => Promise<void> } };
    File.prototype.write = async (v: string) => { st.written = v; };
    const item = (n: number, name: string, size: number) => ({
      id: n.toString(16).padStart(32, "0"), kind: "image" as const, size, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true,
      meta: { name, mime: "image/jpeg", size, lastModified: 1, capture_ts: 1 },
    });
    const mine = item(1, "IMG_1.jpg", 10), planted = item(2, "private.jpg", 424242);
    st.own = new Set([mine.id]);
    await engine.rememberForBackground([mine, planted], { background: true } as never);
    const local = JSON.parse(st.written) as { userId: string; prints: Record<string, string> };
    expect(local.userId).toBe("u1");
    expect(local.prints).toEqual({ [await fingerprint("IMG_1.jpg", 10)]: mine.id });
  });
});
