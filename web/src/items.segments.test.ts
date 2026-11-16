import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { b64, getSodium, type Sodium } from "./crypto/sodium";
import { encryptMeta, newItemKey, wrapItemKey } from "./crypto/item";
import { encryptSegment, segmentCount, SEG_PLAIN } from "./crypto/file";

// The number of segments in the server's list record is plain: one that doesn't fit the size in the metadata marks the
// item broken, and an original is never handed out shorter than its size. The server is a stand-in; crypto is real.
const srv = vi.hoisted(() => ({ list: [] as unknown[], segments: [] as Uint8Array[], fetched: 0 }));
vi.mock("./api", () => ({
  api: async (_m: string, path: string) => (path.startsWith("/api/items") ? { items: srv.list, next: "", cursor: "c" + Math.random(), quota_left: 1, unlimited: true } : {}),
  getBytes: async (path: string) => { srv.fetched++; return srv.segments[Number(path.split("/").pop())]; },
  putBytes: async () => {},
}));
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };

let s: Sodium;
const master = new Uint8Array(32).fill(3);
const id = "0123456789abcdef0123456789abcdef";
const size = 2 * SEG_PLAIN + 123;
let itemKey: Uint8Array;
beforeAll(async () => {
  s = await getSodium();
  itemKey = newItemKey(s);
  const plain = new Uint8Array(size).fill(7);
  const n = segmentCount(size);
  srv.segments = Array.from({ length: n }, (_, i) => encryptSegment(s, itemKey, id, i, n, size, plain.subarray(i * SEG_PLAIN, Math.min(size, (i + 1) * SEG_PLAIN))));
});

const meta = { name: "a.mov", mime: "video/quicktime", size, lastModified: 1, capture_ts: 1 };
const record = (segment_count: unknown) => ({
  id, kind: "video", size, segment_count, created_at: 1, has_thumb: false, has_preview: false,
  wrapped_item_key: b64(s, wrapItemKey(s, itemKey, master, id)), meta_enc: b64(s, encryptMeta(s, meta, itemKey, id)),
});

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  srv.fetched = 0;
  const { mem } = await import("./state");
  mem.me = { user: { id: "u1", email: "a@x.org", role: "user" } } as never;
  mem.masterKey = master.slice();
});

describe("segment count from the server", () => {
  it("takes a count that fits the size, and the original comes back whole", async () => {
    const items = await import("./items");
    srv.list = [record(3)];
    const it = (await items.loadItems()).items[0];
    expect(it.broken).toBeFalsy();
    expect((await items.fetchOriginal(it)).size).toBe(size);
  });

  for (const n of [0, -1, null, 2, 4, 1.5, "3"]) {
    it(`marks the item broken for ${JSON.stringify(n)}`, async () => {
      const items = await import("./items");
      srv.list = [record(n)];
      expect((await items.loadItems()).items[0].broken).toBe(true);
    });
  }

  it("a later list with another count for an already decrypted record is checked again", async () => {
    const items = await import("./items");
    srv.list = [record(3)];
    expect((await items.loadItems()).items[0].broken).toBeFalsy();
    srv.list = [{ ...record(3), segment_count: 0, favorite: true }];
    expect((await items.loadItems()).items[0].broken).toBe(true);
  });

  it("never returns a short original", async () => {
    const items = await import("./items");
    srv.list = [record(3)];
    const it = (await items.loadItems()).items[0];
    for (const n of [0, -1, NaN, null]) {
      await expect(items.fetchOriginal({ ...it, segment_count: n as number })).rejects.toThrow();
    }
    expect(srv.fetched).toBe(0);
  });
});
