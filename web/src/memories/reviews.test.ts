import { beforeEach, describe, expect, test, vi } from "vitest";

// The reviews document against a stand-in server that keeps versions like the real one (409 on a stale version, 404
// for a name it doesn't know); the crypto is the real one.
const st = vi.hoisted(() => ({
  blob: null as null | { data_enc: string; version: number },
  old: false,
  /** run once before the next PUT is answered: another device saving in between */
  before: null as null | (() => Promise<void>),
  mem: { masterKey: null as Uint8Array | null, me: { user: { id: "u1" } } as unknown },
}));
vi.mock("../api", async () => {
  const { ApiError } = await vi.importActual<typeof import("../api")>("../api");
  return {
    ApiError,
    api: async (m: string, p: string, body?: { data_enc: string; version: number }) => {
      if (p !== "/api/me/blobs/reviews" || st.old) throw new ApiError(404, "not found");
      if (m === "GET") { if (!st.blob) throw new ApiError(404, "not found"); return { ...st.blob }; }
      if (st.before) { const f = st.before; st.before = null; await f(); }
      if ((st.blob?.version ?? 0) !== body!.version) throw new ApiError(409, "changed on another device");
      st.blob = { data_enc: body!.data_enc, version: body!.version + 1 };
      return { version: st.blob.version };
    },
  };
});
vi.mock("../state", () => ({ mem: st.mem }));

const fresh = async () => { vi.resetModules(); return import("./reviews"); };

describe("the reviews document", () => {
  beforeEach(() => { Object.assign(st, { blob: null, old: false, before: null }); st.mem.masterKey = new Uint8Array(32).fill(7); });

  test("saved encrypted, read back on another device", async () => {
    const a = await fresh();
    const r = await a.saveReview({ ...a.draft(), query: "dogs at the beach", every: "day" });
    expect(r.id).toMatch(/^[0-9a-f]{16}$/);
    expect(st.blob!.data_enc).not.toContain("dogs");
    const b = await fresh();
    expect((await b.loadReviews()).reviews).toMatchObject([{ id: r.id, name: "dogs at the beach", query: "dogs at the beach", every: "day" }]);
  });

  test("another device saving in between: both changes are kept", async () => {
    const a = await fresh();
    await a.saveReview({ ...a.draft(), query: "cats" });
    const b = await fresh();
    await b.loadReviews();
    st.before = async () => { await b.saveReview({ ...b.draft(), query: "dogs" }); };
    await a.saveReview({ ...a.draft(), query: "birds" });
    const c = await fresh();
    expect((await c.loadReviews()).reviews.map((r) => r.query).sort()).toEqual(["birds", "cats", "dogs"]);
  });

  test("a review deleted elsewhere doesn't come back from an edit here", async () => {
    const a = await fresh();
    const r = await a.saveReview({ ...a.draft(), query: "cats" });
    const b = await fresh();
    await b.loadReviews();
    await a.removeReview(r.id);
    await expect(b.saveReview({ ...r, name: "Cats!" })).rejects.toThrow("deleted on another device");
    expect((await (await fresh()).loadReviews()).reviews).toEqual([]);
  });

  test("watched: recorded once a period", async () => {
    const a = await fresh();
    const r = await a.saveReview({ ...a.draft(), query: "cats", every: "day" });
    await a.watched(r, ["x", "y"], new Date(2026, 10, 20, 9));
    const v = st.blob!.version;
    await a.watched(r, ["z"], new Date(2026, 10, 20, 18));
    expect(st.blob!.version).toBe(v);
    await a.watched(r, ["z"], new Date(2026, 10, 21, 9));
    expect((await (await fresh()).loadReviews()).shown[r.id]).toMatchObject({ ids: ["x", "y", "z"], now: ["z"] });
  });

  test("an old server: nothing to load, saving says the server needs an update", async () => {
    st.old = true;
    const a = await fresh();
    expect((await a.loadReviews()).reviews).toEqual([]);
    await expect(a.saveReview({ ...a.draft(), query: "cats" })).rejects.toThrow(a.OLD_SERVER);
  });
});
