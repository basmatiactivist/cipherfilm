import { beforeEach, describe, expect, it, vi } from "vitest";

// After an unlock, search works from the encrypted copy on the phone before anything comes from the server, and then
// only entries that changed are opened again. The copy is bound to the account and model, and a lock drops it.
const st = vi.hoisted(() => ({
  copy: null as string | null, // what indexLoad gives back (the copy's list), null: none
  loads: [] as { path: string; key: Uint8Array; ad: string }[],
  saves: [] as { path: string; extra: string }[],
  calls: [] as string[], // network, in order, with the native loads
  opened: 0, // entries opened (decrypted)
  vision: { clip: null as string | null, dir: null as string | null, text: false, image: false, faces: false },
  visionOpens: [] as boolean[],
  wipe: (() => {}) as () => void,
  master: new Uint8Array(32).fill(7) as Uint8Array | null,
  gate: null as Promise<void> | null, // holds indexLoad until released
  entries: [] as { item_id: string; data_enc: string; updated_at: number }[],
}));
vi.mock("expo-file-system", () => {
  const uri = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory { uri: string; constructor(...p: unknown[]) { this.uri = p.map(uri).join("/"); } get exists() { return false; } create() {} delete() {} }
  class File {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(uri).join("/"); }
    get exists() { return false; }
    get parentDirectory() { return new Directory("/"); }
    async text() { return "{}"; }
    async write() {}
    delete() {}
  }
  return { Directory, File, Paths: { cache: "file:///cache", document: "file:///doc" } };
});
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    indexLoad: async (path: string, key: Uint8Array, ad: Uint8Array) => {
      st.calls.push("load copy");
      st.loads.push({ path, key: new Uint8Array(key), ad: new TextDecoder().decode(ad) });
      if (st.gate) await st.gate;
      return st.copy;
    },
    indexSave: async (path: string, _key: Uint8Array, _ad: Uint8Array, extra: string) => { st.saves.push({ path, extra }); },
    indexClear: () => { st.calls.push("clear"); },
    indexPut: async () => {},
    indexRemove: () => {},
    indexSearch: async () => [{ id: "a", score: 0.3 }],
    visionText: async () => new Uint8Array(4),
    visionState: () => st.vision,
    visionOpen: async (dir: string, faces: boolean, clip: string, all: boolean) => { st.visionOpens.push(all); Object.assign(st.vision, { dir, clip, text: true, image: all || st.vision.image, faces }); },
    visionClose: () => {},
    backupState: () => ({ unmetered: true }),
  },
}));
vi.mock("@crypto/item", () => ({ accountKeyPair: () => ({ pk: new Uint8Array(32), sk: new Uint8Array(32) }) }));
vi.mock("@crypto/search", () => ({
  openIndexEntry: () => { st.opened++; return { v: 1, m: "mcs2/2", clip: "AAAA" }; },
  sealIndexEntry: () => new Uint8Array(1),
  decryptPeople: () => ({}),
}));
vi.mock("../api", () => ({
  api: async (_m: string, path: string) => {
    st.calls.push(path.split("?")[0]);
    if (path.startsWith("/api/index")) return { entries: st.entries, next: "", now: 1 };
    return {};
  },
  ApiError: class extends Error {},
  server: () => "https://a.test",
}));
vi.mock("../session", () => ({
  onWipe: (f: () => void) => { st.wipe = f; },
  refreshMe: async () => null,
  session: () => ({ me: { user: { id: "alice", email: "alice@x.test" }, wrapped_privkey: "", pubkey: "", session_id: "s", indexer: "" }, masterKey: st.master }),
}));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(0) }));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./settings", () => ({
  loadSettings: async () => ({ enabled: true, faces: false, background: false, wifiOnly: false, chargingOnly: false, asked: true, clip: "mobileclip-s2", indexes: true }),
  saveSettings: async () => {}, settingsDir: () => ({}),
}));
vi.mock("./models", () => ({
  haveModels: async () => true, modelPath: () => "/doc/models", family: () => "mcs2", modelTag: (_c: string, f: boolean) => (f ? "mcs2+faces/2" : "mcs2/2"),
  dropOtherModels: () => [], downloadModels: async () => {}, downloadSize: () => 0, tokenizerFile: () => ({ text: async () => "{}" }),
}));
vi.mock("./tokenizer", () => ({ Tokenizer: class { encode() { return [1]; } } }));

const engine = await import("./engine");
const lib = (ids: string[]) => ids.map((id) => ({ id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true })) as never[];

describe("search after unlocking", () => {
  beforeEach(() => {
    st.wipe(); // as a lock does
    Object.assign(st, { copy: null, loads: [], saves: [], calls: [], opened: 0, visionOpens: [], master: new Uint8Array(32).fill(7), gate: null, entries: [] });
    st.vision = { clip: null, dir: null, text: false, image: false, faces: false };
  });

  it("searches from the copy on the phone before anything comes from the server, with the text model only", async () => {
    st.copy = JSON.stringify({ v: 1, items: { a: ["mcs2/2", "x"], b: ["mcs2/2", "y"] } });
    await engine.warmSearch();
    expect(st.calls).toEqual(["load copy"]); // nothing over the network yet
    expect(engine.searchReady()).toBe(true);
    expect(engine.searchProgress().phase).toBe("ready");
    expect(st.visionOpens).toEqual([false]); // not the image or face models
    expect(await engine.textSearch("dog")).toEqual([{ id: "a", score: 0.3 }]);
    // bound to this account and model, under a key derived from the master key (not the master key itself)
    expect(st.loads[0].path).toBe("/cache/cf-ct/alice/index-mcs2.bin");
    expect(st.loads[0].ad).toBe("cipherfilm search index copy v1|alice|mcs2");
    expect(st.loads[0].key).toHaveLength(32);
    expect([...st.loads[0].key]).not.toEqual([...st.master!]);
  });

  it("then opens only the entries that changed since, and keeps the copy up to date", async () => {
    const enc = (s: string) => `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${s}`;
    st.copy = JSON.stringify({ v: 1, items: { a: ["mcs2/2", enc("aaaaaaaaaaaaaaaaaaaaaaaa").slice(-24)], b: ["mcs2/2", enc("bbbbbbbbbbbbbbbbbbbbbbbb").slice(-24)] } });
    st.entries = [
      { item_id: "a", data_enc: enc("aaaaaaaaaaaaaaaaaaaaaaaa"), updated_at: 1 }, // unchanged
      { item_id: "b", data_enc: enc("BBBBBBBBBBBBBBBBBBBBBBBB"), updated_at: 2 }, // made again on another device
      { item_id: "c", data_enc: enc("cccccccccccccccccccccccc"), updated_at: 3 }, // new
    ];
    await engine.startSearch(lib(["a", "b", "c"]));
    expect(st.opened).toBe(2);
    const saved = JSON.parse(st.saves.at(-1)!.extra);
    expect(Object.keys(saved.items).sort()).toEqual(["a", "b", "c"]);
    expect(saved.items.b[1]).toBe("BBBBBBBBBBBBBBBBBBBBBBBB");
    // a second start opens nothing again
    st.opened = 0;
    await engine.startSearch(lib(["a", "b", "c"]));
    expect(st.opened).toBe(0);
  });

  it("a copy still loading when the library locks is dropped", async () => {
    st.copy = JSON.stringify({ v: 1, items: { a: ["mcs2/2", "x"] } });
    let release = () => {};
    st.gate = new Promise((r) => { release = r; });
    const warm = engine.warmSearch();
    await new Promise((r) => setTimeout(r, 0));
    st.master = null; st.wipe(); // locked
    release();
    await warm;
    expect(engine.searchReady()).toBe(false);
    expect(st.calls.at(-1)).toBe("clear");
  });

  it("without a copy (first start, or another account's) everything is opened, as before", async () => {
    st.entries = [{ item_id: "a", data_enc: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", updated_at: 1 }];
    await engine.warmSearch();
    expect(engine.searchReady()).toBe(false);
    await engine.startSearch(lib(["a"]));
    expect(st.opened).toBe(1);
    expect(engine.searchReady()).toBe(true);
    expect(st.saves).toHaveLength(1);
  });
});
