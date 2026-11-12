import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { b64, getSodium, type Sodium } from "./crypto/sodium";
import { encryptMeta, newItemKey, wrapItemKey } from "./crypto/item";

// A server that hands out an older sealed copy of an item's metadata (a removed place back) is not followed: in the
// session the newer metadata stays; after a lock, when only its version is known, the item is marked stale and a
// download never gives the original by default. The server and the browser's storage are stand-ins; crypto is real.
const pages = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("./api", () => ({
  api: async (_m: string, path: string) => (path.startsWith("/api/items") ? { items: pages.list, next: "", cursor: "c" + Math.random(), quota_left: 1, unlimited: true } : {}),
  getBytes: async () => new Uint8Array(), putBytes: async () => {},
}));
// as in a browser, the stored keys are also the object's own keys (Object.keys(localStorage))
const store = new Map<string, string>();
const ls: any = {};
for (const [k, f] of Object.entries({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); ls[k] = v; },
  removeItem: (k: string) => { store.delete(k); delete ls[k]; },
})) Object.defineProperty(ls, k, { value: f, enumerable: false });
(globalThis as any).localStorage = ls;

let s: Sodium;
const master = new Uint8Array(32).fill(3);
const id = "0123456789abcdef0123456789abcdef";
let itemKey: Uint8Array;
beforeAll(async () => { s = await getSodium(); itemKey = newItemKey(s); });

const record = (meta: object) => ({
  id, kind: "image", size: 10, segment_count: 1, created_at: 1, has_thumb: false, has_preview: false,
  wrapped_item_key: b64(s, wrapItemKey(s, itemKey, master, id)), meta_enc: b64(s, encryptMeta(s, meta, itemKey, id)),
});
const base = { name: "a.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1 };
const uploaded = { ...base, gps: { lat: 46.5, lon: 7.5 } };
const removed = { ...base, orig: { gps: { lat: 46.5, lon: 7.5 } }, mv: 1 };

beforeEach(async () => {
  vi.resetModules();
  for (const k of [...store.keys()]) ls.removeItem(k);
  const { mem } = await import("./state");
  mem.me = { user: { id: "u1", email: "a@x.org", role: "user" } } as never;
  mem.masterKey = master.slice();
});

describe("older metadata from the server", () => {
  it("keeps the newer metadata seen in this session", async () => {
    const items = await import("./items");
    pages.list = [record(removed)];
    expect((await items.loadItems()).items[0].meta?.gps).toBeUndefined();
    pages.list = [record(uploaded)]; // the server replays the upload's metadata
    const it = (await items.loadItems()).items[0];
    expect(it.meta?.gps).toBeUndefined();
    expect(it.meta?.mv).toBe(1);
    expect(it.stale).toBeFalsy();
  });

  it("after a lock only the version is known: the item is stale and never downloads as the original", async () => {
    let items = await import("./items");
    pages.list = [record(removed)];
    await items.loadItems();
    expect(JSON.parse(store.get("cf-mv:u1")!)).toEqual([[id, 1]]); // ids and numbers only
    vi.resetModules();
    items = await import("./items"); // a reload of the tab: nothing decrypted is left
    const { mem } = await import("./state");
    mem.me = { user: { id: "u1", email: "a@x.org", role: "user" } } as never;
    mem.masterKey = master.slice();
    pages.list = [record(uploaded)];
    const it = (await items.loadItems()).items[0];
    expect(it.stale).toBe(true);
    const { leavesAs } = await import("./edit/edit");
    expect(leavesAs(it.kind, it.meta, it.stale)).toBe("retag"); // its own pixels, no place
    // a newer version is taken as usual
    pages.list = [record({ ...uploaded, mv: 2 })];
    items.forgetDecrypted();
    expect((await items.loadItems()).items[0].stale).toBeFalsy();
  });

  it("sign-out forgets the versions", async () => {
    const items = await import("./items");
    pages.list = [record(removed)];
    await items.loadItems();
    items.clearUploadMemory();
    expect(store.has("cf-mv:u1")).toBe(false);
  });
});
