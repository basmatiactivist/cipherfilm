import { beforeEach, describe, expect, it, vi } from "vitest";

// Archiving and the locked folder are written only inside the item's encrypted metadata, like an edit: the PUT carries
// nothing but the sealed metadata, which (decrypted here with the real crypto) says `locked: true`, has its version
// raised and keeps every other field. Server and session are stand-ins.
const puts = vi.hoisted(() => [] as { path: string; body: Record<string, unknown> }[]);
const who = vi.hoisted(() => ({ demo: false, fail: "", master: new Uint8Array(32) }));
const forgot = vi.hoisted(() => [] as string[]);
vi.mock("./api", () => ({
  api: async (method: string, path: string, body: Record<string, unknown>) => {
    if (path.includes(who.fail)) throw new Error("HTTP 500");
    if (method === "PUT") puts.push({ path, body });
    return {};
  },
}));
vi.mock("./session", () => ({ session: () => ({ me: { user: { id: "u1" }, demo: who.demo }, masterKey: who.master }), onWipe: () => {} }));
vi.mock("./library", () => ({ forgetPictures: (id: string) => { forgot.push(id); } }));

const { moveTo, movable } = await import("./moveFolder");
const { getSodium } = await import("@crypto/sodium");
const { decryptMeta, newItemKey } = await import("@crypto/item");
const { folderOf } = await import("@edit/folders");

const id = (n: number) => n.toString(16).padStart(32, "0");

describe("moving items between folders", () => {
  beforeEach(() => { puts.length = 0; forgot.length = 0; who.demo = false; who.fail = "never"; });

  it("writes `locked: true` only inside the encrypted metadata, version raised, every other field kept", async () => {
    const s = await getSodium();
    const key = newItemKey(s);
    const meta = { name: "IMG_1.jpg", mime: "image/jpeg", size: 100, lastModified: 5, capture_ts: 7, gps: { lat: 47.1, lon: 8.2 }, mv: 3, archived: true as const, future: "kept" };
    const it = { id: id(1), kind: "image" as const, size: 100, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, meta, itemKey: key, favorite: true };
    const r = await moveTo([it], "locked");
    expect(r).toEqual({ moved: [id(1)], failed: 0 });
    expect(puts.map((p) => p.path)).toEqual([`/api/items/${id(1)}/meta`]);
    const body = puts[0].body;
    expect(Object.keys(body)).toEqual(["meta_enc"]); // no plaintext flag next to it
    expect(JSON.stringify(body)).not.toMatch(/locked|archived/);
    const sealed = decryptMeta<Record<string, unknown>>(s, s.from_base64(body.meta_enc as string, s.base64_variants.URLSAFE_NO_PADDING), key, id(1));
    const { archived: _was, ...rest } = meta; // locked replaces archived (one folder at a time)
    expect(sealed).toEqual({ ...rest, locked: true, mv: 4 });
    expect(folderOf(sealed)).toBe("locked");
    expect(forgot).toEqual([id(1)]); // what this phone cached of it goes
    expect(it.meta.mv).toBe(3); // the item in the list isn't changed in place: the next load brings it
  });

  it("archives and brings back the same way, and leaves what is there already alone", async () => {
    const s = await getSodium();
    const mk = (n: number, extra: object = {}) => ({ id: id(n), kind: "image" as const, size: 1, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, itemKey: newItemKey(s), meta: { name: `${n}.jpg`, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0, ...extra } });
    const a = mk(1), b = mk(2, { archived: true });
    const r = await moveTo([a, b], "archive");
    expect(r.moved.sort()).toEqual([id(1), id(2)]);
    expect(puts.length).toBe(1); // b was archived already
    const sealed = decryptMeta<Record<string, unknown>>(s, s.from_base64(puts[0].body.meta_enc as string, s.base64_variants.URLSAFE_NO_PADDING), a.itemKey, id(1));
    expect(sealed.archived).toBe(true);
    expect(sealed.mv).toBe(1);
    expect(forgot).toEqual([]);
    puts.length = 0;
    await moveTo([b], "library");
    const back = decryptMeta<Record<string, unknown>>(s, s.from_base64(puts[0].body.meta_enc as string, s.base64_variants.URLSAFE_NO_PADDING), b.itemKey, id(2));
    expect(back).not.toHaveProperty("archived");
    expect(back).not.toHaveProperty("locked");
  });

  it("reports what couldn't be moved (stale, broken, a failed request) and goes on with the rest", async () => {
    const s = await getSodium();
    const mk = (n: number, extra: object = {}) => ({ id: id(n), kind: "image" as const, size: 1, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, itemKey: newItemKey(s), meta: { name: "x", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0 }, ...extra });
    who.fail = id(3);
    const stale = mk(1, { stale: true }), broken = mk(2, { broken: true }), failing = mk(3), fine = mk(4);
    expect(movable(stale)).toBe(false);
    let progress = 0;
    const r = await moveTo([stale, broken, failing, fine], "locked", (d) => { progress = d; });
    expect(r).toEqual({ moved: [id(4)], failed: 3 });
    expect(progress).toBe(4);
  });

  it("is refused in the public demo, like editing", async () => {
    who.demo = true;
    await expect(moveTo([], "archive")).rejects.toThrow(/demo/);
    expect(puts).toEqual([]);
  });
});
