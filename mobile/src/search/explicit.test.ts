import { beforeEach, describe, expect, it, vi } from "vitest";

// Explicit search on (docs/SEARCH.md): the phone that indexes makes LAION's entries and keeps MobileCLIP's current
// too, for the devices that can't use explicit search (the Play build, an older app, a person not allowed). It fills
// in MobileCLIP's entries an older app deleted, finding the faces once. Real engine and models list; the server, the
// phone's storage, the native models and the sealing are stand-ins (an entry travels as base64url JSON here).
const st = vi.hoisted(() => ({
  explicit: true, // the people document's choice
  offered: true, // false: the Play build
  faces: true,
  server: { mcs2: [] as { item_id: string; data_enc: string; updated_at: number }[], laionb32: [] as { item_id: string; data_enc: string; updated_at: number }[] },
  clock: 1,
  puts: [] as { id: string; model: string; faces?: unknown }[],
  gets: [] as string[],
  deletes: [] as string[],
  analyzed: [] as { faces: boolean; clips: string[] }[],
  opens: [] as { clip: string; indexes: boolean; also: string | null }[],
  files: new Map<string, string>(),
  master: new Uint8Array(32).fill(7),
  vision: { clip: null as string | null, dir: null as string | null, text: false, image: false, faces: false, also: null as string | null },
}));
vi.mock("expo-file-system", () => {
  const uri = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory { uri: string; constructor(...p: unknown[]) { this.uri = p.map(uri).join("/"); } get exists() { return false; } create() {} delete() {} }
  class File {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(uri).join("/"); }
    get exists() { return st.files.has(this.uri); }
    get parentDirectory() { return new Directory("/"); }
    async text() { return st.files.get(this.uri)!; }
    async write(v: string) { st.files.set(this.uri, v); }
    delete() { st.files.delete(this.uri); }
  }
  return { Directory, File, Paths: { cache: "file:///cache", document: "file:///doc" } };
});
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (t: string) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const enc = (e: unknown) => b64u(new TextEncoder().encode(JSON.stringify(e)));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    indexLoad: async () => null,
    indexSave: async () => {},
    indexClear: () => {}, indexPut: async () => {}, indexRemove: () => {},
    visionState: () => st.vision,
    visionOpen: async (dir: string, faces: boolean, clip: string, indexes: boolean, also: string | null) => {
      st.opens.push({ clip, indexes, also });
      Object.assign(st.vision, { dir, clip, text: true, image: indexes, faces: indexes && faces, also });
    },
    visionClose: () => {},
    visionAnalyze: async (_b: Uint8Array, faces: boolean, clips: string[]) => {
      st.analyzed.push({ faces, clips });
      return { clips: clips.map((_, i) => new Uint8Array([i + 1])), ...(faces ? { faces: [{ box: [0, 0, 1, 1], score: 0.9, emb: new Uint8Array([9]) }] } : {}) };
    },
    backupState: () => ({ unmetered: true }),
    backupNotify: () => {},
    checkModel: async () => true,
  },
}));
vi.mock("@crypto/item", () => ({ accountKeyPair: () => ({ pk: new Uint8Array(32), sk: new Uint8Array(32) }) }));
vi.mock("@crypto/search", () => ({
  openIndexEntry: (_s: unknown, blob: Uint8Array) => dec(blob),
  sealIndexEntry: (_s: unknown, e: unknown) => new TextEncoder().encode(JSON.stringify(e)),
  decryptPeople: () => (st.explicit ? { explicit: true } : {}),
}));
vi.mock("../api", () => ({
  api: async (method: string, path: string, body?: { data_enc: string; model: string }) => {
    const u = new URL(path, "https://a.test");
    if (method === "DELETE") { st.deletes.push(path); return {}; }
    if (u.pathname === "/api/me/blobs/people") return { data_enc: "AAAA", version: 1 };
    if (u.pathname === "/api/index") {
      const fam = u.searchParams.get("model") as "mcs2" | "laionb32";
      st.gets.push(fam);
      const since = Number(u.searchParams.get("since") ?? 0);
      return { entries: st.server[fam].filter((e) => e.updated_at >= since), next: "", now: st.clock, count: st.server[fam].length };
    }
    if (method === "PUT" && body) {
      const id = path.split("/")[3], fam = body.model.split(/[+/]/)[0] as "mcs2" | "laionb32";
      st.puts.push({ id, model: body.model, faces: dec(unb64u(body.data_enc)).faces });
      st.server[fam] = [...st.server[fam].filter((e) => e.item_id !== id), { item_id: id, data_enc: body.data_enc, updated_at: ++st.clock }];
      return {};
    }
    return {};
  },
  ApiError: class extends Error {},
  server: () => "https://a.test",
}));
vi.mock("../session", () => ({
  onWipe: () => {},
  refreshMe: async () => null,
  session: () => ({ me: { user: { id: "alice", email: "alice@x.test", nsfw: true }, wrapped_privkey: "", pubkey: b64u(new Uint8Array(32)), session_id: "s", indexer: "s" }, masterKey: st.master }),
}));
vi.mock("../store", () => ({ explicitSearchOffered: () => st.offered }));
vi.mock("../library", () => ({ imageBytes: async () => new Uint8Array(4) }));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../keepAlive", () => ({ keepRunning: () => true, letGo: () => {}, onlyHolder: () => true }));
vi.mock("./settings", () => ({
  loadSettings: async () => ({ enabled: true, faces: st.faces, background: false, wifiOnly: false, chargingOnly: false, asked: true }),
  saveSettings: async () => {}, settingsDir: () => ({}),
}));
vi.mock("./models", async (orig) => ({ ...(await orig<typeof import("./models")>()), haveModels: async () => true, downloadModels: async () => {}, dropOtherModels: () => [] }));
vi.mock("./tokenizer", () => ({ Tokenizer: class { encode() { return [1]; } } }));

const engine = await import("./engine");
const lib = (ids: string[]) => ids.map((id) => ({ id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true, itemKey: new Uint8Array(32) })) as never[];
const A = "a".repeat(32), B = "b".repeat(32);
const FACE = { box: [0.2, 0.2, 0.3, 0.3], score: 0.97, emb: "AAAA" };
const L = "laionb32+yunet23+sface21/1", M = "mcs2+yunet23+sface21/2";

describe("the indexing phone with explicit search on", () => {
  beforeEach(() => {
    engine.forgetSearch(false); // a fresh start: nothing in memory or the cache here
    Object.assign(st, { explicit: true, offered: true, faces: true, server: { mcs2: [], laionb32: [] }, clock: 1, puts: [], gets: [], deletes: [], analyzed: [], opens: [] });
    st.files.clear();
    st.vision = { clip: null, dir: null, text: false, image: false, faces: false, also: null };
  });

  it("makes both families' entries, looking at each photo once, and fills in MobileCLIP's an older app deleted", async () => {
    // a has LAION's entry (with a face); MobileCLIP's were deleted when explicit search was turned on. b has neither.
    st.server.laionb32 = [{ item_id: A, data_enc: enc({ v: 1, m: L, clip: "AQ", faces: [FACE] }), updated_at: 1 }];
    await engine.startSearch(lib([A, B]));
    expect(engine.searchProgress()).toMatchObject({ phase: "ready" });
    expect(st.opens.at(-1)).toEqual({ clip: "laion-b32", indexes: true, also: "mobileclip-s2" });
    // a: only MobileCLIP's vector, its face taken from LAION's entry; b: both vectors, faces found once
    expect(st.analyzed).toEqual([{ faces: false, clips: ["mobileclip-s2"] }, { faces: true, clips: ["laion-b32", "mobileclip-s2"] }]);
    expect(st.puts.map((p) => [p.id, p.model])).toEqual([[A, M], [B, L], [B, M]]);
    expect(st.puts[0].faces).toEqual([FACE]);
    expect(st.puts[1].faces).toEqual(st.puts[2].faces);
    expect(st.deletes).toEqual([]);

    // the next start has nothing to do
    st.analyzed = []; st.puts = [];
    await engine.startSearch(lib([A, B]));
    expect(st.analyzed).toEqual([]);
    expect(st.puts).toEqual([]);
  });

  it("notices MobileCLIP's entries were deleted on the server since its last visit, and makes them again", async () => {
    // both complete, from another device that indexed before
    for (const [i, id] of [A, B].entries()) {
      st.server.laionb32.push({ item_id: id, data_enc: enc({ v: 1, m: L, clip: "AQ", faces: [FACE] }), updated_at: 10 + i });
      st.server.mcs2.push({ item_id: id, data_enc: enc({ v: 1, m: M, clip: "Ag", faces: [FACE] }), updated_at: 10 + i });
    }
    st.clock = 20;
    await engine.startSearch(lib([A, B]));
    expect(st.analyzed).toEqual([]);
    // an older app on another device turns explicit search on: MobileCLIP's go, LAION's stay
    st.server.mcs2 = [];
    st.gets = [];
    await engine.startSearch(lib([A, B]));
    expect(st.gets).toEqual(["laionb32", "mcs2", "mcs2"]); // nothing new since, but fewer than here: all again
    expect(st.analyzed).toEqual([{ faces: false, clips: ["mobileclip-s2"] }, { faces: false, clips: ["mobileclip-s2"] }]);
    expect(st.puts.map((p) => [p.model, p.faces])).toEqual([[M, [FACE]], [M, [FACE]]]);
  });

  it("explicit search off: only MobileCLIP, as before", async () => {
    st.explicit = false;
    await engine.startSearch(lib([A]));
    expect(st.gets).toEqual(["mcs2"]);
    expect(st.opens.at(-1)).toEqual({ clip: "mobileclip-s2", indexes: true, also: null });
    expect(st.puts.map((p) => p.model)).toEqual([M]);
  });

  it("the Play build searches and indexes with MobileCLIP whatever the account chose, and never asks for LAION's", async () => {
    st.offered = false;
    st.server.laionb32 = [{ item_id: A, data_enc: enc({ v: 1, m: L, clip: "AQ", faces: [] }), updated_at: 1 }];
    await engine.startSearch(lib([A]));
    expect(engine.activeClip()).toBe("mobileclip-s2");
    expect(st.gets).toEqual(["mcs2"]);
    expect(st.opens.every((o) => o.clip === "mobileclip-s2" && o.also === null)).toBe(true);
    expect(st.puts.map((p) => p.model)).toEqual([M]);
  });

  it("switching explicit search on and off keeps MobileCLIP's entries, on the server and in the copy here", async () => {
    const copy = () => JSON.parse(st.files.get("file:///cache/cf-ct/alice/index-mcs2.json") ?? "{}").entries ?? {};
    st.explicit = false;
    await engine.startSearch(lib([A, B]));
    expect(Object.keys(copy()).sort()).toEqual([A, B]);
    st.explicit = true; // on: LAION's are added, MobileCLIP's stay
    await engine.startSearch(lib([A, B]));
    expect(st.server.mcs2.length).toBe(2);
    expect(Object.keys(copy()).sort()).toEqual([A, B]);
    st.explicit = false; st.puts = []; st.analyzed = []; // off again: nothing to make again
    await engine.startSearch(lib([A, B]));
    expect(st.puts).toEqual([]);
    expect(st.deletes.some((d) => d.includes("mcs2"))).toBe(false);
    expect(Object.keys(copy()).sort()).toEqual([A, B]);
  });
});
