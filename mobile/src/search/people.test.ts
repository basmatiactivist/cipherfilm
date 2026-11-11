import { beforeEach, describe, expect, it, vi } from "vitest";

// Explicit search on or off changes only what search shows (docs/SEARCH.md "Explicit content"): nothing on the server
// is deleted either way.
const st = vi.hoisted(() => ({ doc: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("@crypto/search", () => ({ decryptPeople: () => st.doc, encryptPeople: (_s: unknown, d: Record<string, unknown>) => { st.doc = d; return new Uint8Array(41); } }));
vi.mock("../api", () => ({
  api: async (method: string, path: string) => { st.calls.push(`${method} ${path}`); return method === "GET" ? { data_enc: "AAAA", version: 1 } : { version: 2 }; },
  ApiError: class extends Error {},
}));
vi.mock("../session", () => ({ onWipe: () => {}, session: () => ({ me: { user: { id: "alice", nsfw: true } }, masterKey: new Uint8Array(32) }) }));
vi.mock("../libraryStore", () => ({ libraryItems: () => [] }));
vi.mock("../library", () => ({ thumbBytes: async () => null }));
vi.mock("./engine", () => ({ indexVersion: () => 0, searchReady: () => false }));
vi.mock("./settings", () => ({ loadSettings: async () => ({}) }));

const { setExplicit, sameFaces } = await import("./people");
const deletes = () => st.calls.filter((c) => c.startsWith("DELETE"));

describe("explicit search on and off", () => {
  beforeEach(() => { st.doc = { v: 1, people: [] }; st.calls = []; });

  it("on: nothing is deleted on the server", async () => {
    await setExplicit(true);
    expect(st.doc.explicit).toBe(true);
    expect(deletes()).toEqual([]);
  });

  it("off: nothing is deleted either (one model and one index for everyone; only what search shows changes)", async () => {
    st.doc = { v: 1, people: [], explicit: true };
    await setExplicit(false);
    expect(st.doc.explicit).toBeUndefined();
    expect(deletes()).toEqual([]);
  });

  it("unchanged: nothing is deleted", async () => {
    st.doc = { v: 1, people: [], explicit: true };
    await setExplicit(true);
    expect(deletes()).toEqual([]);
  });
});

describe("following a person across a regrouping", () => {
  it("picks the group that shares the most faces, and nothing when none is shared", () => {
    const gs = [{ key: "a", faces: ["x1", "y1"] }, { key: "b", faces: ["x2", "x3", "x4"] }, { key: "c", faces: ["z1"] }];
    expect(sameFaces(gs, new Set(["x2", "x3", "y1"]))?.key).toBe("b");
    expect(sameFaces(gs, new Set(["q"]))).toBeUndefined();
  });
});
