import { beforeEach, describe, expect, it, vi } from "vitest";

// The album list is kept current with ?since: after the whole list, a change fetches only the albums that changed
// (each whole) and the ids of those deleted, and decrypts only those names. The server and the crypto are stand-ins.
const st = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  asked: [] as string[],
  decrypted: [] as string[],
  mem: { masterKey: new Uint8Array(32).fill(1) as Uint8Array | null },
}));
vi.mock("./api", () => ({
  api: async (_m: string, p: string) => { st.asked.push(p); if (!(p in st.answers)) throw new Error("unexpected " + p); return structuredClone(st.answers[p]); },
}));
vi.mock("./state", () => ({ mem: st.mem }));
vi.mock("./items", () => ({ inBatches: async () => {} }));
vi.mock("./crypto/sodium", () => ({ getSodium: async () => ({}), b64: () => "", unb64: (_s: unknown, v: string) => v }));
vi.mock("./crypto/item", () => ({
  encryptAlbumName: () => new Uint8Array(),
  decryptAlbumName: (_s: unknown, enc: string, _m: unknown, id: string) => { st.decrypted.push(id); if (enc === "bad") throw new Error("bad"); return `name ${enc}`; },
}));

const raw = (id: string, name: string, created: number, items: string[] = []) => ({ id, name_enc: name, created_at: created, item_ids: items });
const E = "0123456789abcdef";

describe("albums on the web", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { answers: {}, asked: [], decrypted: [] });
    st.mem.masterKey = new Uint8Array(32).fill(1);
  });

  it("loads the whole list once, then only what changed", async () => {
    const { loadAlbums } = await import("./albums");
    st.answers["/api/albums"] = { albums: [raw("a", "A", 1, ["x"]), raw("b", "B", 2), raw("c", "bad", 3)], cursor: `${E}.5` };
    const first = await loadAlbums();
    expect(first.map((a) => [a.id, a.name, a.itemIds, !!a.broken])).toEqual([["a", "name A", ["x"], false], ["b", "name B", [], false], ["c", "Unreadable album", [], true]]);
    expect(st.decrypted).toEqual(["a", "b", "c"]);

    // a photo added to b, a deleted, d created
    st.decrypted = []; st.asked = [];
    st.answers[`/api/albums?since=${E}.5`] = { albums: [raw("b", "B", 2, ["x", "y"]), raw("d", "D", 4)], removed: ["a"], cursor: `${E}.9`, more: false, reset: false };
    const next = await loadAlbums();
    expect(st.asked).toEqual([`/api/albums?since=${E}.5`]);
    expect(st.decrypted).toEqual(["b", "d"]);
    expect(next.map((a) => [a.id, a.itemIds])).toEqual([["b", ["x", "y"]], ["c", []], ["d", []]]);

    // nothing changed: nothing decrypted, the list as it was
    st.decrypted = [];
    st.answers[`/api/albums?since=${E}.9`] = { albums: [], removed: [], cursor: `${E}.9`, more: false, reset: false };
    expect((await loadAlbums()).map((a) => a.id)).toEqual(["b", "c", "d"]);
    expect(st.decrypted).toEqual([]);
  });

  it("a reset, a server without cursors, a new master key and forgetAlbums load the whole list", async () => {
    const { loadAlbums, forgetAlbums } = await import("./albums");
    st.answers["/api/albums"] = { albums: [raw("a", "A", 1)], cursor: `${E}.5` };
    await loadAlbums();
    st.answers[`/api/albums?since=${E}.5`] = { albums: [], removed: [], cursor: `${E}.7`, reset: true };
    st.asked = [];
    await loadAlbums();
    expect(st.asked).toEqual([`/api/albums?since=${E}.5`, "/api/albums"]);

    st.asked = [];
    st.mem.masterKey = new Uint8Array(32).fill(2); // another account, or the key unlocked again
    await loadAlbums();
    expect(st.asked).toEqual(["/api/albums"]);

    st.asked = [];
    forgetAlbums();
    await loadAlbums();
    expect(st.asked).toEqual(["/api/albums"]);

    // an older server: no cursor, so every load is whole
    st.answers["/api/albums"] = { albums: [raw("a", "A", 1)] };
    forgetAlbums();
    await loadAlbums();
    st.asked = [];
    await loadAlbums();
    expect(st.asked).toEqual(["/api/albums"]);
  });

  it("refuses while locked", async () => {
    const { loadAlbums } = await import("./albums");
    st.mem.masterKey = null;
    await expect(loadAlbums()).rejects.toThrow("Unlock");
  });
});
