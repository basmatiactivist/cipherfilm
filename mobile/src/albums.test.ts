import { beforeEach, describe, expect, it, vi } from "vitest";

// The album list on the phone is kept current with ?since: after the whole list, a live update fetches only the
// albums that changed (each whole) and the ids of those deleted, and decrypts only those names. The server, the
// session and the crypto are stand-ins.
const st = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  asked: [] as string[],
  decrypted: [] as string[],
  master: new Uint8Array(32).fill(1) as Uint8Array | null,
  wipes: [] as (() => void)[],
}));
vi.mock("./api", () => ({
  api: async (_m: string, p: string) => { st.asked.push(p); if (!(p in st.answers)) throw new Error("unexpected " + p); return structuredClone(st.answers[p]); },
}));
vi.mock("./session", () => ({ session: () => ({ masterKey: st.master }), onWipe: (f: () => void) => { st.wipes.push(f); } }));
vi.mock("@crypto/sodium", () => ({ getSodium: async () => ({}), b64: () => "", unb64: (_s: unknown, v: string) => v }));
vi.mock("@crypto/item", () => ({
  encryptAlbumName: () => new Uint8Array(),
  decryptAlbumName: (_s: unknown, enc: string, _m: unknown, id: string) => { st.decrypted.push(id); if (enc === "bad") throw new Error("bad"); return `name ${enc}`; },
}));

const raw = (id: string, name: string, created: number, items: string[] = []) => ({ id, name_enc: name, created_at: created, item_ids: items });
const E = "0123456789abcdef";

describe("albums on the phone", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { answers: {}, asked: [], decrypted: [], wipes: [] });
    st.master = new Uint8Array(32).fill(1);
  });

  it("loads the whole list once, then only what changed", async () => {
    const { loadAlbums } = await import("./albums");
    st.answers["/api/albums"] = { albums: [raw("a", "A", 1, ["x"]), raw("b", "B", 2), raw("c", "bad", 3)], cursor: `${E}.5` };
    const first = await loadAlbums();
    expect(first.map((a) => [a.id, a.name, a.itemIds, !!a.broken])).toEqual([["a", "name A", ["x"], false], ["b", "name B", [], false], ["c", "Unreadable album", [], true]]);

    st.decrypted = []; st.asked = [];
    st.answers[`/api/albums?since=${E}.5`] = { albums: [raw("b", "B2", 2, ["x", "y"]), raw("d", "D", 4)], removed: ["a"], cursor: `${E}.9`, more: false, reset: false };
    const next = await loadAlbums();
    expect(st.asked).toEqual([`/api/albums?since=${E}.5`]);
    expect(st.decrypted).toEqual(["b", "d"]);
    expect(next.map((a) => [a.id, a.name, a.itemIds])).toEqual([["b", "name B2", ["x", "y"]], ["c", "Unreadable album", []], ["d", "name D", []]]);
  });

  it("a lock, a new master key and a reset load the whole list", async () => {
    const { loadAlbums } = await import("./albums");
    st.answers["/api/albums"] = { albums: [raw("a", "A", 1)], cursor: `${E}.5` };
    await loadAlbums();
    st.asked = [];
    st.wipes.forEach((f) => f()); // locked
    await loadAlbums();
    expect(st.asked).toEqual(["/api/albums"]);

    st.asked = [];
    st.master = new Uint8Array(32).fill(2);
    await loadAlbums();
    expect(st.asked).toEqual(["/api/albums"]);

    st.asked = [];
    st.answers[`/api/albums?since=${E}.5`] = { albums: [], removed: [], cursor: `${E}.6`, reset: true };
    await loadAlbums();
    expect(st.asked).toEqual([`/api/albums?since=${E}.5`, "/api/albums"]);
  });
});
