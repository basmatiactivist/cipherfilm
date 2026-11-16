import { describe, expect, it, vi } from "vitest";

// "Free up space" offers a phone original for the phone's trash only for an item the owner's own devices made: this
// phone's own upload, or an item whose key is wrapped with the master key (another device, or this phone before 2.7.0).
// An item whose key is only sealed to the public key (anyone holding it can add one, with any name and size) never
// makes a phone original look safe to remove.
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
vi.mock("./session", () => ({ onSignOut: () => {} }));

const { alreadyIn } = await import("./freeSpace");
const { noteOwnUpload } = await import("./ownUploads");
const { getSodium, b64 } = await import("@crypto/sodium");
const { newItemKey, sealItemKey, wrapItemKey } = await import("@crypto/item");
type Item = Parameters<typeof alreadyIn>[1][number];

const id = (n: number) => n.toString(16).padStart(32, "0");
const media = (n: number, name: string, size: number) => ({ id: n, uri: `content://media/external/images/media/${n}`, name, size, mime: "image/jpeg", bucket: "b", folder: "Camera", taken: 1 });

describe("free up space", () => {
  it("offers only phone files that match an item this phone uploaded, with the key it sent", async () => {
    const s = await getSodium();
    const pk = s.crypto_box_keypair().publicKey;
    const item = (n: number, name: string, size: number, wrapped: string, extra: Partial<Item> = {}): Item => ({
      id: id(n), kind: "image", size, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, wrapped,
      meta: { name, mime: "image/jpeg", size, lastModified: 1, capture_ts: 1 }, ...extra,
    });
    const wrap = (n: number) => b64(s, sealItemKey(s, newItemKey(s), pk, id(n)));
    const mine = item(1, "IMG_1.jpg", 100, wrap(1)); // backed up from this phone
    const planted = item(2, "IMG_2.jpg", 200, wrap(2)); // added by someone else, naming a file on this phone
    const swapped = item(3, "IMG_3.jpg", 300, wrap(3)); // this phone's upload, its key since replaced
    const broken = item(4, "IMG_4.jpg", 400, wrap(4), { broken: true }); // this phone's, but not verified
    await noteOwnUpload("u1", mine.id, mine.wrapped!);
    await noteOwnUpload("u1", swapped.id, wrap(3));
    await noteOwnUpload("u1", broken.id, broken.wrapped!);
    const phone = [media(1, "IMG_1.jpg", 100), media(2, "IMG_2.jpg", 200), media(3, "IMG_3.jpg", 300), media(4, "IMG_4.jpg", 400), media(5, "IMG_1.jpg", 101)];

    expect((await alreadyIn("u1", [mine, planted, swapped, broken], phone)).map((m) => m.id)).toEqual([1]);
    // another account on this phone, or none: nothing is offered
    expect(await alreadyIn("u2", [mine], phone)).toEqual([]);
    expect(await alreadyIn(undefined, [mine], phone)).toEqual([]);
  });

  it("also offers phone files that match an item under the master key, made before own uploads were recorded", async () => {
    const s = await getSodium();
    const pk = s.crypto_box_keypair().publicKey;
    const master = s.randombytes_buf(32);
    const item = (n: number, name: string, size: number, wrapped: string, extra: Partial<Item> = {}): Item => ({
      id: id(n), kind: "image", size, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, wrapped, itemKey: new Uint8Array(32),
      meta: { name, mime: "image/jpeg", size, lastModified: 1, capture_ts: 1 }, ...extra,
    });
    const old = item(11, "IMG_11.jpg", 110, b64(s, wrapItemKey(s, newItemKey(s), master, id(11)))); // backed up before 2.7.0, or from the Mac
    const forged = item(12, "IMG_12.jpg", 120, b64(s, sealItemKey(s, newItemKey(s), pk, id(12)))); // sealed only, not recorded here
    const unopened = item(13, "IMG_13.jpg", 130, b64(s, wrapItemKey(s, newItemKey(s), master, id(13))), { itemKey: undefined }); // not opened
    const failed = item(14, "IMG_14.jpg", 140, b64(s, wrapItemKey(s, newItemKey(s), master, id(14))), { broken: true });
    const phone = [media(11, "IMG_11.jpg", 110), media(12, "IMG_12.jpg", 120), media(13, "IMG_13.jpg", 130), media(14, "IMG_14.jpg", 140)];
    expect((await alreadyIn("u1", [old, forged, unopened, failed], phone)).map((m) => m.id)).toEqual([11]);
    expect((await alreadyIn("u3", [old, forged], phone)).map((m) => m.id)).toEqual([11]); // no own uploads recorded at all
    expect(await alreadyIn(undefined, [old], phone)).toEqual([]);
  });
});
