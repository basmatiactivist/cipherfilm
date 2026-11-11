import { beforeEach, describe, expect, it, vi } from "vitest";

// The library list on the phone, kept current with ?since: a live update fetches and decrypts only what changed, the
// native thumbnails get only the new keys, and list.json keeps the records with their cursor so the next start asks
// only for what changed after it. Server, crypto, files and the native module are stand-ins.
const st = vi.hoisted(() => ({
  files: new Map<string, string>(),
  answers: {} as Record<string, any>,
  asked: [] as string[],
  decrypted: [] as string[],
  keyed: [] as string[],
  master: new Uint8Array(32),
  forgot: [] as string[],
}));
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return [...st.files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    // the files right in this folder (pruneCache)
    list() { return [...st.files.keys()].filter((k) => k.startsWith(this.uri + "/") && !k.slice(this.uri.length + 1).includes("/")).map((k) => new File(this.uri, k.slice(this.uri.length + 1))); }
  }
  class File {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return st.files.has(this.uri); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")), ""); }
    async text() { return st.files.get(this.uri)!; }
    async write(v: string) { st.files.set(this.uri, v); }
    get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
    get modificationTime() { return 0; }
    delete() { st.files.delete(this.uri); }
  }
  return { Directory, File, Paths: { cache: "/cache" } };
});
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: { thumbsSetup: () => {}, thumbKeys: (ids: string[]) => { st.keyed.push(...ids); }, thumbsPrefetch: () => {}, thumbsForget: (ids: string[]) => { st.forgot.push(...ids); } },
}));
vi.mock("./api", () => ({
  api: async (_m: string, p: string) => { st.asked.push(p); if (!st.answers[p]) throw new Error("unexpected " + p); return structuredClone(st.answers[p]); },
  csrfToken: () => "", server: () => "https://x", getBytes: async () => new Uint8Array(), postForBytes: async () => new Uint8Array(),
}));
vi.mock("./session", () => ({
  session: () => ({ me: { user: { id: "alice", email: "a@x.org" }, wrapped_privkey: "" }, masterKey: st.master }),
  onWipe: () => {},
}));
vi.mock("@crypto/sodium", () => ({ getSodium: async () => ({ memzero: () => {} }), unb64: (_s: unknown, v: string) => v }));
vi.mock("@crypto/account", () => ({ normEmail: (e: string) => e }));
vi.mock("@crypto/item", () => ({
  accountKeyPair: () => ({ sk: new Uint8Array(32) }),
  unwrapAnyItemKey: (_s: unknown, _w: unknown, _m: unknown, _p: unknown, id: string) => { st.decrypted.push(id); return new Uint8Array(32); },
  decryptMeta: (_s: unknown, meta: string) => JSON.parse(meta),
  decryptPreview: () => new Uint8Array(), decryptThumb: () => new Uint8Array(),
}));

const rec = (id: string, ts: number, extra: object = {}) => ({
  id, kind: "image", size: 10, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, favorite: false,
  wrapped_item_key: "k-" + id, meta_enc: JSON.stringify({ name: id, mime: "image/jpeg", size: 10, lastModified: 0, capture_ts: ts }), ...extra,
});
const ids = (l: { id: string }[]) => l.map((x) => x.id);
const LIST = "/cache/cf-ct/alice/list.json";
// item ids as the app checks them
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32), D = "d".repeat(32);

describe("the library on the phone", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    Object.assign(st, { files: new Map(), answers: {}, asked: [], decrypted: [], keyed: [], forgot: [] });
  });

  it("after the whole list, a live update fetches and decrypts only what changed", async () => {
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A, 1), rec(B, 2), rec(C, 3)], next: "", cursor: "e.5" };
    expect(ids(await lib.loadLibrary())).toEqual([C, B, A]);
    expect(st.decrypted.length).toBe(3);
    // the whole list is kept at once, with its cursor
    expect(JSON.parse(st.files.get(LIST)!).cursor).toBe("e.5");

    st.decrypted = []; st.keyed = [];
    st.answers["/api/items?since=e.5"] = { items: [rec(D, 4), rec(A, 1, { favorite: true })], removed: [B], cursor: "e.8", more: false };
    const after = await lib.loadLibrary();
    expect(ids(after)).toEqual([D, C, A]);
    expect(after.find((x) => x.id === A)!.favorite).toBe(true);
    expect(st.decrypted).toEqual([D]); // A's key and metadata are the same: not decrypted again
    expect(st.keyed.sort()).toEqual([A, D]); // the native thumbnails get only what came
    expect(st.asked.filter((p) => p === "/api/items").length).toBe(1);

    // nothing new: the same array back (the store redoes nothing then)
    st.answers["/api/items?since=e.8"] = { items: [], removed: [], cursor: "e.8", more: false };
    expect(await lib.loadLibrary()).toBe(after);
  });

  it("checks an edit like the rest, and drops the pictures kept here when another device made new ones", async () => {
    const lib = await import("./library");
    const meta = (extra: object) => JSON.stringify({ name: "a.jpg", mime: "image/jpeg", size: 10, lastModified: 0, capture_ts: 1, ...extra });
    st.answers["/api/items"] = { items: [rec(A, 1, { meta_enc: meta({ edit: { rot: 45, crop: "x" }, orig: { gps: "far" } }) })], next: "", cursor: "e.1" };
    const first = await lib.loadLibrary();
    expect(first[0].meta).not.toHaveProperty("edit"); // nonsense from some device: dropped
    expect(first[0].meta).not.toHaveProperty("orig");
    st.files.set(`/cache/cf-ct/alice/thumb-${A}`, "old");
    st.answers["/api/items?since=e.1"] = { items: [rec(A, 1, { meta_enc: meta({ edit: { rot: 90, v: "n1" }, capture_ts: 1.6 }) })], removed: [], cursor: "e.2", more: false };
    const after = await lib.loadLibrary();
    expect(after[0].meta!.edit).toEqual({ rot: 90, v: "n1" });
    expect(after[0].meta!.capture_ts).toBe(2);
    expect(st.forgot).toEqual([A]); // the native thumbnails load the new one
    expect(st.files.has(`/cache/cf-ct/alice/thumb-${A}`)).toBe(false); // and the encrypted copy kept here goes
    // a change that leaves the picture as it is (a new date) keeps them
    st.answers["/api/items?since=e.2"] = { items: [rec(A, 1, { meta_enc: meta({ edit: { rot: 90, v: "n1" }, capture_ts: 5 }) })], removed: [], cursor: "e.3", more: false };
    await lib.loadLibrary();
    expect(st.forgot).toEqual([A]);
  });

  it("an item's kind comes from its encrypted metadata, never from the server's plain field", async () => {
    const lib = await import("./library");
    const vid = JSON.stringify({ name: "clip.mp4", mime: "video/mp4", size: 10, lastModified: 0, capture_ts: 2 });
    st.answers["/api/items"] = { items: [rec(A, 1, { kind: "video" }), rec(B, 2, { kind: "image", meta_enc: vid })], next: "", cursor: "e.1" };
    const first = await lib.loadLibrary();
    expect(first.find((x) => x.id === A)!.kind).toBe("image");
    expect(first.find((x) => x.id === B)!.kind).toBe("video");
    // the same records again with the server's kind flipped: what was decrypted is kept, and so is its kind
    st.answers["/api/items?since=e.1"] = { items: [rec(A, 1, { kind: "other", favorite: true })], removed: [], cursor: "e.2", more: false };
    expect((await lib.loadLibrary()).find((x) => x.id === A)!.kind).toBe("image");
  });

  it("list.json keeps records and cursor together, written a few seconds after changes", async () => {
    vi.useFakeTimers();
    const lib = await import("./library");
    st.answers["/api/items"] = { items: [rec(A, 1)], next: "", cursor: "e.1" };
    await lib.loadLibrary();
    st.answers["/api/items?since=e.1"] = { items: [rec(B, 2)], removed: [A], cursor: "e.3", more: false };
    await lib.loadLibrary();
    expect(JSON.parse(st.files.get(LIST)!).cursor).toBe("e.1"); // not yet
    await vi.advanceTimersByTimeAsync(5000);
    const kept = JSON.parse(st.files.get(LIST)!);
    expect(kept.cursor).toBe("e.3");
    expect(ids(kept.items)).toEqual([B]);
  });

  it("the next start shows the kept list and asks only for what changed after it", async () => {
    st.files.set(LIST, JSON.stringify({ cursor: "e.3", wholeAt: Date.now(), items: [rec(A, 1), rec(B, 2)] }));
    st.answers["/api/items?since=e.3"] = { items: [rec(C, 3)], removed: [A], cursor: "e.4", more: false };
    const lib = await import("./library");
    expect(ids((await lib.loadCachedLibrary())!)).toEqual([B, A]);
    expect(ids(await lib.loadLibrary())).toEqual([C, B]);
    expect(st.asked).toEqual(["/api/items?since=e.3"]);
  });

  it("a kept list whose last whole load is more than a day old loads whole once (the daily safety net)", async () => {
    st.files.set(LIST, JSON.stringify({ cursor: "e.3", wholeAt: Date.now() - 25 * 3600_000, items: [rec(A, 1)] }));
    st.answers["/api/items"] = { items: [rec(A, 1), rec(B, 2)], next: "", cursor: "e.9" };
    const lib = await import("./library");
    await lib.loadCachedLibrary();
    expect(ids(await lib.loadLibrary())).toEqual([B, A]);
    expect(st.asked).toEqual(["/api/items"]);
  });

  it("a list.json from before (records only), a reset, and a lock all load the whole list", async () => {
    st.files.set(LIST, JSON.stringify([rec(A, 1)]));
    st.answers["/api/items"] = { items: [rec(A, 1), rec(B, 2)], next: "", cursor: "e.2" };
    const lib = await import("./library");
    await lib.loadCachedLibrary();
    expect(ids(await lib.loadLibrary())).toEqual([B, A]);
    expect(st.asked).toEqual(["/api/items"]);

    st.answers["/api/items?since=e.2"] = { items: [], removed: [], cursor: "f.0", reset: true };
    await lib.loadLibrary();
    expect(st.asked).toEqual(["/api/items", "/api/items?since=e.2", "/api/items"]);

    lib.forgetLists();
    await lib.loadLibrary();
    expect(st.asked.at(-1)).toBe("/api/items");
  });

  it("the trash follows its own changes, newest trashed first", async () => {
    const lib = await import("./library");
    st.answers["/api/trash"] = { items: [rec(A, 1, { trashed_at: 10 })], next: "", cursor: "e.1", retention_days: 30 };
    expect(ids((await lib.loadTrash()).items)).toEqual([A]);
    st.answers["/api/trash?since=e.1"] = { items: [rec(B, 2, { trashed_at: 20 })], removed: [A], cursor: "e.3", more: false, retention_days: 30 };
    const r = await lib.loadTrash();
    expect(ids(r.items)).toEqual([B]);
    expect(r.retentionDays).toBe(30);
  });

  it("pruning the cache keeps the search index's copies of both model families (explicit search, the Play build)", async () => {
    const lib = await import("./library");
    const dir = "/cache/cf-ct/alice";
    for (const f of ["list.json", "index-mcs2.json", "index-mcs2.bin", "index-laionb32.json", "index-laionb32.bin",
      `thumb-${A}`, `preview-${A}`, `thumb-${B}`, `preview-${B}`, ".index-mcs2.bin.tmp", "stray"]) st.files.set(`${dir}/${f}`, "x");
    lib.pruneCache(new Set([A]));
    expect([...st.files.keys()].map((k) => k.slice(dir.length + 1)).sort()).toEqual(
      ["index-laionb32.bin", "index-laionb32.json", "index-mcs2.bin", "index-mcs2.json", "list.json", `preview-${A}`, `thumb-${A}`].sort());
  });
});

describe("the original's SHA-256 in the metadata", () => {
  it("is kept when it is 64 lowercase hex characters, and dropped otherwise", async () => {
    const { checkedMeta } = await import("./library");
    const base = { name: "a.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 1 };
    const good = "0f".repeat(32);
    expect(checkedMeta({ ...base, sha256: good }).sha256).toBe(good);
    for (const bad of ["0F".repeat(32), "0f".repeat(31), 42, null, ""]) expect(checkedMeta({ ...base, sha256: bad as never })).not.toHaveProperty("sha256");
    expect(checkedMeta({ ...base })).not.toHaveProperty("sha256");
  });
});
