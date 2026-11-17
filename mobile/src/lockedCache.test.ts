import { beforeEach, describe, expect, it, vi } from "vitest";

// Nothing of a locked item on disk: its key never reaches the native thumbnails (which keep only verified ciphertext
// on disk), its thumbnail and preview are neither read from nor written to the encrypted cache folder, and what was
// cached before it moved into the locked folder is deleted. The trash never lists it. Server, crypto, files and the
// native module are stand-ins (as in library.test.ts).
const st = vi.hoisted(() => ({
  files: new Map<string, string | Uint8Array>(),
  answers: {} as Record<string, any>,
  keyed: [] as string[],
  prefetched: [] as string[],
  forgot: [] as string[],
  fetched: [] as string[],
  master: new Uint8Array(32),
}));
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return [...st.files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    list() { return [...st.files.keys()].filter((k) => k.startsWith(this.uri + "/") && !k.slice(this.uri.length + 1).includes("/")).map((k) => new File(this.uri, k.slice(this.uri.length + 1))); }
  }
  class File {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return st.files.has(this.uri); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")), ""); }
    async text() { return st.files.get(this.uri) as string; }
    textSync() { return st.files.get(this.uri) as string; }
    async bytes() { return st.files.get(this.uri) as Uint8Array; }
    async write(v: string | Uint8Array) { st.files.set(this.uri, v); }
    get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
    get modificationTime() { return 0; }
    delete() { st.files.delete(this.uri); }
  }
  return { Directory, File, Paths: { cache: "/cache", document: "/doc" } };
});
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    thumbsSetup: () => {}, thumbKeys: (ids: string[]) => { st.keyed.push(...ids); },
    thumbsPrefetch: (ids: string[]) => { st.prefetched.push(...ids); }, thumbsForget: (ids: string[]) => { st.forgot.push(...ids); },
    base64: () => "QQ==",
  },
}));
vi.mock("./api", () => ({
  api: async (_m: string, p: string) => { if (!st.answers[p]) throw new Error("unexpected " + p); return structuredClone(st.answers[p]); },
  csrfToken: () => "", server: () => "https://x",
  getBytes: async (p: string) => { st.fetched.push(p); return new Uint8Array([1, 2, 3]); },
  postForBytes: async () => { throw Object.assign(new Error("gone"), { status: 404 }); },
}));
vi.mock("./session", () => ({
  session: () => ({ me: { user: { id: "alice", email: "a@x.org" }, wrapped_privkey: "" }, masterKey: st.master }),
  onOwnSignOut: () => {}, onWipe: () => {},
}));
vi.mock("@crypto/sodium", () => ({ getSodium: async () => ({ memzero: () => {} }), unb64: (_s: unknown, v: string) => v }));
vi.mock("@crypto/account", () => ({ normEmail: (e: string) => e }));
vi.mock("@crypto/item", () => ({
  accountKeyPair: () => ({ sk: new Uint8Array(32) }),
  unwrapAnyItemKey: () => new Uint8Array(32),
  decryptMeta: (_s: unknown, meta: string) => JSON.parse(meta),
  decryptPreview: () => new Uint8Array([9]), decryptThumb: () => new Uint8Array([9]),
}));

const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
const meta = (extra: object = {}) => JSON.stringify({ name: "x.jpg", mime: "image/jpeg", size: 10, lastModified: 0, capture_ts: 1, ...extra });
const rec = (id: string, extra: object = {}, m: object = {}) => ({
  id, kind: "image", size: 10, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, favorite: false,
  wrapped_item_key: "k-" + id, meta_enc: meta(m), ...extra,
});
const DIR = "/cache/cf-ct/alice";

describe("locked items and the cache on this phone", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { files: new Map(), answers: {}, keyed: [], prefetched: [], forgot: [], fetched: [] });
  });

  it("never hands a locked item's key to the native thumbnails; fetching ahead asks for it too, but keeps nothing", async () => {
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A), rec(B, {}, { locked: true }), rec(C, {}, { archived: true })], next: "", cursor: "e.1" };
    const list = await lib.loadLibrary();
    expect(list.find((i) => i.id === B)!.meta!.locked).toBe(true);
    expect(st.keyed.sort()).toEqual([A, C]);
    lib.prefetchThumbs(list);
    await new Promise((r) => setTimeout(r, 50));
    expect(st.prefetched.sort()).toEqual([A, C]); // into the encrypted cache, natively
    // which thumbnails are asked for doesn't depend on the folder: the locked one's is fetched and dropped
    expect(st.fetched).toEqual([`/api/items/${B}/thumb`]);
    expect([...st.files.keys()].filter((k) => k.includes(B))).toEqual([]);
    // once per app start, also over locks (the open ones' stay in the cache over locks too)
    lib.prefetchThumbs(list);
    await new Promise((r) => setTimeout(r, 50));
    expect(st.fetched).toHaveLength(1);
  });

  it("a stale item is handled as a locked one: no key for the native thumbnails, nothing cached", async () => {
    let lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A, {}, { locked: true, mv: 1 })], next: "", cursor: "e.1" };
    await lib.loadLibrary();
    vi.resetModules(); // the app started again: only the version is known
    st.keyed = [];
    lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A)], next: "", cursor: "e.2" }; // the copy from before the lock
    const [it] = await lib.loadLibrary();
    expect(it.stale).toBe(true);
    expect(st.keyed).toEqual([]);
    const { splitLocked } = await import("@edit/folders");
    expect(splitLocked([it]).open).toEqual([]);
    await lib.thumbBytes(it);
    await lib.previewUri(it);
    expect([...st.files.keys()].filter((k) => k.startsWith(DIR) && !k.endsWith("list.json"))).toEqual([]);
    lib.prefetchThumbs([it]);
    expect(st.prefetched).toEqual([]);
  });

  it("writes an open item's thumbnail and preview ciphertext to the cache, a locked item's never", async () => {
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A), rec(B, {}, { locked: true })], next: "", cursor: "e.1" };
    const list = await lib.loadLibrary();
    const [open, locked] = [list.find((i) => i.id === A)!, list.find((i) => i.id === B)!];
    (await lib.thumbBytes(open)).fill(0);
    (await lib.imageBytes(open)).fill(0);
    expect(st.files.has(`${DIR}/thumb-${A}`)).toBe(true);
    expect(st.files.has(`${DIR}/preview-${A}`)).toBe(true);
    expect(await lib.thumbBytes(locked)).toEqual(new Uint8Array([9]));
    await lib.imageBytes(locked);
    await lib.previewUri(locked);
    expect([...st.files.keys()].filter((k) => k.includes(B))).toEqual([]);
    // fetched from the server every time instead (memory only): a planted file is never read either
    st.files.set(`${DIR}/thumb-${B}`, new Uint8Array([7]));
    st.fetched = [];
    await lib.thumbBytes(locked);
    expect(st.fetched).toEqual([`/api/items/${B}/thumb`]);
  });

  it("deletes what was cached of an item once it moved into the locked folder (here or on another device)", async () => {
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A)], next: "", cursor: "e.1" };
    const [open] = await lib.loadLibrary();
    await lib.thumbBytes(open);
    expect(st.files.has(`${DIR}/thumb-${A}`)).toBe(true);
    st.answers["/api/items?since=e.1"] = { items: [rec(A, { meta_enc: meta({ locked: true, mv: 1 }) })], removed: [], cursor: "e.2", more: false };
    await lib.loadLibrary();
    expect(st.files.has(`${DIR}/thumb-${A}`)).toBe(false);
    expect(st.forgot).toEqual([A]); // the native bitmap and its own copy go too
  });

  it("the trash never lists a locked item", async () => {
    const lib = await import("./library");
    st.answers["/api/trash"] = { items: [rec(A, { trashed_at: 5 }), rec(B, { trashed_at: 6 }, { locked: true })], next: "", cursor: "t.1", retention_days: 30 };
    expect((await lib.loadTrash()).items.map((i) => i.id)).toEqual([A]);
  });

  it("only `true` counts as a flag: other values are dropped after decrypting", async () => {
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A, {}, { locked: "yes", archived: 1 })], next: "", cursor: "e.1" };
    const [it] = await lib.loadLibrary();
    expect(it.meta).not.toHaveProperty("locked");
    expect(it.meta).not.toHaveProperty("archived");
    expect(st.keyed).toEqual([A]);
  });
});
