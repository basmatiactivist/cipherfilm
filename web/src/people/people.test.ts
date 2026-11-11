import { beforeEach, describe, expect, it, vi } from "vitest";

// Explicit search on or off only changes what search shows (docs/SEARCH.md "Explicit content"): one model and one index
// for everyone, so nothing is deleted on the server either way.
const st = vi.hoisted(() => ({ doc: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("./faces", () => ({ FaceIndex: class {} }));
vi.mock("../search/content", () => ({ clearContent: () => {}, putVectors: () => {} }));
vi.mock("../crypto/search", () => ({ decryptPeople: () => st.doc, encryptPeople: (_s: unknown, d: Record<string, unknown>) => { st.doc = d; return new Uint8Array(41); } }));
vi.mock("../api", () => ({
  api: async (method: string, path: string) => { st.calls.push(`${method} ${path}`); return method === "GET" ? { data_enc: "AAAA", version: 1 } : { version: 2 }; },
  ApiError: class extends Error {},
}));
vi.mock("../state", () => ({ mem: { me: { user: { id: "alice", nsfw: true } }, masterKey: new Uint8Array(32) } }));

const { setExplicit } = await import("./people");
const deletes = () => st.calls.filter((c) => c.startsWith("DELETE"));

describe("explicit search on and off", () => {
  beforeEach(() => { st.doc = { v: 1, people: [] }; st.calls = []; });

  it("on: nothing is deleted on the server", async () => {
    await setExplicit(true);
    expect(st.doc.explicit).toBe(true);
    expect(deletes()).toEqual([]);
  });

  it("off: nothing is deleted either (the index is everyone's)", async () => {
    st.doc = { v: 1, people: [], explicit: true };
    await setExplicit(false);
    expect(st.doc.explicit).toBeUndefined();
    expect(deletes()).toEqual([]);
  });

  it("filtered unless the admin allows it and the person chose it", async () => {
    const { searchFiltered } = await import("./people");
    st.doc = { v: 1, people: [], explicit: true };
    await setExplicit(true);
    expect(searchFiltered()).toBe(false);
    await setExplicit(false);
    expect(searchFiltered()).toBe(true);
  });

  it("unchanged: nothing is deleted", async () => {
    st.doc = { v: 1, people: [], explicit: true };
    await setExplicit(true);
    expect(deletes()).toEqual([]);
  });
});
