import { beforeEach, describe, expect, it, vi } from "vitest";

// The locked folder's pictures (edit/folders.ts) never go into Cache Storage, live in memory apart from the others and
// leave it when the folder closes; an item moving into the folder takes its stored copies with it.
vi.mock("./api", () => ({
  getBytes: async (path: string) => new TextEncoder().encode("ct:" + path),
  postForBytes: async () => { throw Object.assign(new Error("no batch"), { status: 404 }); },
}));
vi.mock("./crypto/sodium", () => ({ getSodium: async () => ({}) }));
vi.mock("./crypto/item", () => ({ decryptThumb: (_s: unknown, ct: Uint8Array) => ct, decryptPreview: (_s: unknown, ct: Uint8Array) => ct }));
vi.mock("./thumbbatch", () => ({ ThumbBatcher: class { constructor(private _b: unknown, private one: (id: string, w: () => boolean) => Promise<Uint8Array>) {} get(id: string, w: () => boolean) { return this.one(id, w); } } }));

const stores = new Map<string, Map<string, Uint8Array>>();
(globalThis as any).caches = {
  open: async (name: string) => {
    const m = stores.get(name) ?? new Map<string, Uint8Array>();
    stores.set(name, m);
    return {
      match: async (url: string) => (m.has(url) ? new Response(m.get(url) as BlobPart) : undefined),
      put: async (url: string, r: Response) => { m.set(url, new Uint8Array(await r.arrayBuffer())); },
      delete: async (url: string) => m.delete(url),
    };
  },
  delete: async (name: string) => stores.delete(name),
};
let urls = 0;
const revoked: string[] = [];
(globalThis as any).URL.createObjectURL = () => `blob:${++urls}`;
(globalThis as any).URL.revokeObjectURL = (u: string) => revoked.push(u);

const item = (id: string, meta: object) => ({ id, kind: "image", size: 1, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, itemKey: new Uint8Array(32), meta: { name: "a", mime: "image/jpeg", size: 1, lastModified: 1, capture_ts: 1, ...meta } }) as any;
const settle = () => new Promise((r) => setTimeout(r, 20));
const storedUrls = () => [...stores.values()].flatMap((m) => [...m.keys()]).filter((u) => !u.endsWith("preview-index"));

beforeEach(() => { vi.resetModules(); stores.clear(); revoked.length = 0; });

describe("pictures of the locked folder", () => {
  it("are never stored, and leave memory when the folder closes", async () => {
    const c = await import("./cache");
    const open = item("a".repeat(32), {}), locked = item("b".repeat(32), { locked: true });
    for (const i of [open, locked]) c.wantImage("thumb", i.id);
    await c.thumbUrl(open); await c.thumbUrl(locked); await c.previewUrl(locked);
    await settle();
    expect(storedUrls()).toEqual([`/ct/thumb/${open.id}`]);
    expect(c.cachedThumb(locked)).toBeDefined();
    expect(c.cachedThumb({ id: locked.id, meta: {} as any })).toBeUndefined(); // not in the others' cache
    c.forgetLocked();
    expect(c.cachedThumb(locked)).toBeUndefined();
    expect(c.cachedPreview(locked)).toBeUndefined();
    expect(c.cachedThumb(open)).toBeDefined();
    expect(revoked).toHaveLength(2);
  });

  it("an item moving into the folder takes its stored copies along", async () => {
    const c = await import("./cache");
    const it = item("c".repeat(32), {});
    c.wantImage("thumb", it.id);
    await c.thumbUrl(it); await c.previewUrl(it);
    await settle();
    expect(storedUrls().sort()).toEqual([`/ct/preview/${it.id}`, `/ct/thumb/${it.id}`]);
    await c.dropStored([it]);
    expect(storedUrls()).toEqual([]);
    expect(c.cachedThumb(it)).toBeUndefined();
  });
});
