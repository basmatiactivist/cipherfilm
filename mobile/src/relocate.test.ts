import { describe, expect, it, vi } from "vitest";

// the app's files, in memory
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return [...files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    delete() { for (const k of [...files.keys()]) if (k.startsWith(this.uri + "/")) files.delete(k); }
  }
  class File {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return files.has(this.uri); }
    async text() { return files.get(this.uri)!; }
    async write(v: string) { files.set(this.uri, v); }
  }
  return { Directory, File, Paths: { document: "/doc", cache: "/cache" } };
});
vi.mock("expo-asset", () => ({ Asset: { fromModule: () => ({}) } }));
// the phone: whole library readable, every original taken at the same place
const phone = vi.hoisted(() => ({ media: [] as unknown[] }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {
  backupState: () => ({ media: "full" }), mediaLocationAllowed: () => true,
  phoneMedia: async () => phone.media, mediaInfo: async () => ({ lat: 47.1, lon: 8.2 }),
} }));
const puts = vi.hoisted(() => [] as { path: string; body: { meta_enc: string } }[]);
vi.mock("./api", () => ({ api: async (method: string, path: string, body: { meta_enc: string }) => { if (method === "PUT") puts.push({ path, body }); return {}; } }));
const lib = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("./session", () => ({ session: () => ({ me: { user: { id: "u1" } }, masterKey: new Uint8Array(32) }), onWipe: () => {}, onSignOut: () => {} }));
vi.mock("./libraryStore", () => ({ libraryItems: () => lib.items, refreshLibrary: async () => {} }));

const { lacking, matchOnPhone, relocate } = await import("./relocate");
const { noteOwnUpload } = await import("./ownUploads");
const { getSodium, b64 } = await import("@crypto/sodium");
const { decryptMeta, newItemKey, sealItemKey, unwrapAnyItemKey } = await import("@crypto/item");
type Item = Parameters<typeof lacking>[0][number];

const item = (id: string, name: string, size: number, extra: Partial<Item> = {}): Item => ({
  id, kind: "image", size, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true,
  itemKey: new Uint8Array(32), meta: { name, mime: "image/jpeg", size, lastModified: 1, capture_ts: 1 }, ...extra,
});
const media = (id: number, name: string, size: number) => ({ id, uri: `content://media/external/images/media/${id}`, name, size, mime: "image/jpeg", bucket: "b", folder: "Camera", taken: 1 });

describe("adding where photos were taken afterwards", () => {
  it("looks only at finished photos and videos without a location, not looked at before", () => {
    const items = [
      item("a", "IMG_1.jpg", 10),
      item("b", "IMG_2.jpg", 10, { meta: { name: "IMG_2.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1, gps: { lat: 47, lon: 8 } } }),
      item("c", "IMG_3.jpg", 10, { broken: true }),
      item("d", "IMG_4.jpg", 10, { trashed_at: 5 }),
      item("e", "doc.pdf", 10, { kind: "other" }),
      item("f", "VID_1.mp4", 10, { kind: "video" }),
      item("g", "IMG_5.jpg", 10),
      // the person removed its place (editing): it stays without one
      item("h", "IMG_6.jpg", 10, { meta: { name: "IMG_6.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1, orig: { gps: { lat: 1, lon: 2 } } } }),
    ];
    const own = new Set(items.map((i) => i.id));
    expect(lacking(items, new Set(["g"]), own).map((i) => i.id)).toEqual(["a", "f"]);
    // what this phone didn't upload itself is never looked at
    own.delete("a");
    expect(lacking(items, new Set(["g"]), own).map((i) => i.id)).toEqual(["f"]);
  });

  it("finds the phone's file by name and size, or by the picker's number and size", async () => {
    const items = [item("a", "IMG_1.jpg", 100), item("b", "812.jpg", 200), item("c", "813.jpg", 300), item("d", "IMG_9.jpg", 5)];
    const phone = [media(1, "IMG_1.jpg", 100), media(812, "PXL_2026.jpg", 200), media(813, "other.jpg", 999), media(9, "IMG_9.jpg", 6)];
    const found = await matchOnPhone(items, phone);
    expect([...found].map(([it, m]) => [it.id, m.id])).toEqual([["a", 1], ["b", 812]]);
  });

  it("adds the location only to this phone's own uploads, under the item key this phone made", async () => {
    const s = await getSodium();
    const pair = s.crypto_box_keypair();
    const kp = { pk: pair.publicKey, sk: pair.privateKey };
    const id = (n: number) => n.toString(16).padStart(32, "0");
    // an item as the library decrypts it: the key sealed to the account's public key, by whoever added the item
    const sealed = (n: number, name: string, size: number) => {
      const key = newItemKey(s);
      const wrapped = b64(s, sealItemKey(s, key, kp.pk, id(n)));
      return { item: item(id(n), name, size, { itemKey: unwrapAnyItemKey(s, s.from_base64(wrapped, s.base64_variants.URLSAFE_NO_PADDING), new Uint8Array(32), () => kp, id(n)), wrapped }), wrapped, key };
    };
    const mine = sealed(1, "IMG_1.jpg", 100); // backed up from this phone
    const planted = sealed(2, "IMG_2.jpg", 200); // added by someone else, naming a file on this phone
    const swapped = sealed(3, "IMG_3.jpg", 300); // this phone's upload, its key since replaced by another one
    await noteOwnUpload("u1", mine.item.id, mine.wrapped);
    await noteOwnUpload("u1", swapped.item.id, b64(s, sealItemKey(s, newItemKey(s), kp.pk, id(3))));
    lib.items = [mine.item, planted.item, swapped.item];
    phone.media = [media(1, "IMG_1.jpg", 100), media(2, "IMG_2.jpg", 200), media(3, "IMG_3.jpg", 300)];

    expect(await relocate({ force: true })).toBe(1);
    expect(puts.map((p) => p.path)).toEqual([`/api/items/${id(1)}/meta`]);
    const meta = decryptMeta<{ gps?: unknown }>(s, s.from_base64(puts[0].body.meta_enc, s.base64_variants.URLSAFE_NO_PADDING), mine.key, id(1));
    expect(meta.gps).toEqual({ lat: 47.1, lon: 8.2 });
  });
});
