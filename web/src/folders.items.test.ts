import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { b64, getSodium, unb64, type Sodium } from "./crypto/sodium";
import { decryptMeta, encryptMeta, newItemKey, wrapItemKey } from "./crypto/item";

// Archive and locked folder (edit/folders.ts): the folder is written only inside the encrypted metadata, as its next
// version, and a locked item never reaches the list the other views read. The server is a stand-in; crypto is real.
const server = vi.hoisted(() => ({ list: [] as any[], puts: [] as { path: string; body: any }[] }));
vi.mock("./api", () => ({
  api: async (method: string, path: string, body: any) => {
    if (method === "PUT") { server.puts.push({ path, body }); return { ok: true }; }
    return path.startsWith("/api/items") ? { items: server.list, next: "", cursor: "c" + Math.random(), quota_left: 1, unlimited: true } : {};
  },
  getBytes: async () => new Uint8Array(), putBytes: async () => {},
}));
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let s: Sodium;
const master = new Uint8Array(32).fill(5);
const ids = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", "00000000000000000000000000000001"];
const keys: Uint8Array[] = [];
beforeAll(async () => { s = await getSodium(); for (let i = 0; i < ids.length; i++) keys.push(newItemKey(s)); });

const record = (i: number, meta: object) => ({
  id: ids[i], kind: "image", size: 10, segment_count: 1, created_at: 1, has_thumb: true, has_preview: false,
  wrapped_item_key: b64(s, wrapItemKey(s, keys[i], master, ids[i])), meta_enc: b64(s, encryptMeta(s, meta, keys[i], ids[i])),
});
const base = { name: "receipt.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1, gps: { lat: 46.5, lon: 7.5 } };

beforeEach(async () => {
  vi.resetModules();
  server.puts = [];
  const { mem } = await import("./state");
  mem.me = { user: { id: "u1", email: "a@x.org", role: "user" } } as never;
  mem.masterKey = master.slice();
});

describe("moving to a folder", () => {
  it("writes the flag inside the encrypted metadata only, one version higher, every other field kept", async () => {
    const items = await import("./items");
    server.list = [record(0, { ...base, mv: 2, future: "kept" }), record(1, base)];
    const list = (await items.loadItems()).items;
    const r = await items.moveToFolder(list, "locked");
    expect(r).toEqual({ moved: expect.arrayContaining(ids.slice(0, 2)), failed: 0 });
    expect(server.puts).toHaveLength(2);
    for (const put of server.puts) {
      // the request carries nothing but the sealed metadata: no flag, no name, no place in plain text
      expect(Object.keys(put.body)).toEqual(["meta_enc"]);
      const raw = new TextDecoder().decode(unb64(s, put.body.meta_enc));
      for (const word of ["locked", "archived", "receipt", "46.5"]) expect(raw).not.toContain(word);
      const i = ids.indexOf(put.path.split("/")[3]);
      const meta = decryptMeta<any>(s, unb64(s, put.body.meta_enc), keys[i], ids[i]);
      expect(meta.locked).toBe(true);
      expect(meta.archived).toBeUndefined();
      expect(meta.gps).toEqual(base.gps);
      if (i === 0) { expect(meta.mv).toBe(3); expect(meta.future).toBe("kept"); } else expect(meta.mv).toBe(1);
    }
  });

  it("reads the flags back, and only true counts", async () => {
    const items = await import("./items");
    const { splitLocked, mainGrid, archived } = await import("./edit/folders");
    server.list = [record(0, { ...base, locked: true }), record(1, { ...base, archived: true, locked: "yes" }), record(2, { ...base, archived: 1 })];
    const list = (await items.loadItems()).items;
    const { open, locked } = splitLocked(list);
    expect(locked.map((i) => i.id)).toEqual([ids[0]]);
    expect(open.map((i) => i.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(open.find((i) => i.id === ids[1])!.meta).not.toHaveProperty("locked");
    expect(archived(open).map((i) => i.id)).toEqual([ids[1]]);
    expect(mainGrid(open).map((i) => i.id)).toEqual([ids[2]]);
  });

  it("leaves unreadable and stale items alone", async () => {
    const items = await import("./items");
    server.list = [record(0, base)];
    const [it] = (await items.loadItems()).items;
    const r = await items.moveToFolder([{ ...it, stale: true }, { ...it, id: ids[1], broken: true }], "archive").catch((e) => e);
    expect(r).toEqual({ moved: [], failed: 2 });
    expect(server.puts).toHaveLength(0);
  });

  it("is refused for the public demo", async () => {
    const items = await import("./items");
    const { mem } = await import("./state");
    server.list = [record(0, base)];
    const list = (await items.loadItems()).items;
    (mem.me as any).demo = true;
    await expect(items.moveToFolder(list, "archive")).rejects.toThrow(/demo/);
  });
});
