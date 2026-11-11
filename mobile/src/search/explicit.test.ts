import { beforeEach, describe, expect, it, vi } from "vitest";

// One model for everyone (docs/SEARCH.md "One model", "Explicit content"): the indexing phone, whichever build, makes
// the new model's entries, takes the faces of the MobileCLIP entries made before and deletes those once it is done;
// an index explicit search already made with the same model stays. Search leaves explicit photos and words out unless
// an admin allowed explicit search, the person chose it and the build offers it (never Google Play's). Real engine,
// models list and filter; the server, the phone's storage, the native models and the sealing are stand-ins (an entry
// travels as base64url JSON here).
const st = vi.hoisted(() => ({
  explicit: false, // the people document's choice
  offered: true, // false: the Play build
  faces: true,
  server: { mcs2: [] as { item_id: string; data_enc: string; updated_at: number }[], laionb32: [] as { item_id: string; data_enc: string; updated_at: number }[] },
  clock: 1,
  puts: [] as { id: string; model: string; faces?: unknown }[],
  gets: [] as string[],
  deletes: [] as string[],
  analyzed: [] as { faces: boolean; clips: string[] }[],
  opens: [] as { clip: string; indexes: boolean }[],
  concepts: 0,
  searches: [] as boolean[],
  text: new Uint8Array(0) as Uint8Array,
  files: new Map<string, string>(),
  master: new Uint8Array(32).fill(7),
  vision: { clip: null as string | null, dir: null as string | null, text: false, image: false, faces: false },
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
    visionOpen: async (dir: string, faces: boolean, clip: string, indexes: boolean) => {
      st.opens.push({ clip, indexes });
      Object.assign(st.vision, { dir, clip, text: true, image: indexes, faces: indexes && faces });
    },
    visionClose: () => {},
    visionAnalyze: async (_b: Uint8Array, faces: boolean, clips: string[]) => {
      st.analyzed.push({ faces, clips });
      return { clips: clips.map((_, i) => new Uint8Array([i + 1])), ...(faces ? { faces: [{ box: [0, 0, 1, 1], score: 0.9, emb: new Uint8Array([9]) }] } : {}) };
    },
    indexConcepts: async (vecs: Uint8Array, explicit: boolean[], image: boolean[], threshold: number) => {
      if (vecs.length !== explicit.length * 1024 || image.length !== explicit.length || !(threshold > -1)) throw new Error("concepts");
      st.concepts++;
    },
    visionText: async () => st.text,
    indexSearch: async (_q: Uint8Array, _l: number, _m: number, filtered: boolean) => { st.searches.push(filtered); return [{ id: "x", score: 0.3 }]; },
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
    if (method === "DELETE") { st.deletes.push(path); if (path.endsWith("model=mcs2")) st.server.mcs2 = []; return {}; }
    if (u.pathname === "/api/me/blobs/people") return { data_enc: "AAAA", version: 1 };
    if (u.pathname === "/api/index") {
      const fam = u.searchParams.get("model") as "mcs2" | "laionb32";
      st.gets.push(fam);
      const since = Number(u.searchParams.get("since") ?? 0);
      return { entries: st.server[fam].filter((e) => e.updated_at >= since), next: "", now: st.clock, count: st.server[fam].length };
    }
    if (method === "PUT" && body) {
      const id = path.split("/")[3], fam = body.model.split(/[+/]/)[0] as "mcs2" | "laionb32";
      if (fam !== "laionb32") throw Object.assign(new Error("update the app"), { status: 409, code: "not_indexer" });
      st.puts.push({ id, model: body.model, faces: dec(unb64u(body.data_enc)).faces });
      st.server[fam] = [...st.server[fam].filter((e) => e.item_id !== id), { item_id: id, data_enc: body.data_enc, updated_at: ++st.clock }];
      st.server.mcs2 = st.server.mcs2.filter((e) => e.item_id !== id); // as the server does: the new entry replaces it
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
const { conceptData, halfs } = await import("@websearch/explicit");
const lib = (ids: string[]) => ids.map((id) => ({ id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true, itemKey: new Uint8Array(32) })) as never[];
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
const FACE = { box: [0.2, 0.2, 0.3, 0.3], score: 0.97, emb: "AAAA" };
const L = "laionb32+yunet23+sface21/1", M = "mcs2+yunet23+sface21/2";
/** a concept's text vector as the native text model hands it over: little-endian float32 */
const textOf = (k: number) => new Uint8Array(halfs(conceptData().vecs.slice(k * 1024, (k + 1) * 1024)).buffer);

beforeEach(() => {
  engine.forgetSearch(false); // a fresh start: nothing in memory or the cache here
  Object.assign(st, { explicit: false, offered: true, faces: true, server: { mcs2: [], laionb32: [] }, clock: 1, puts: [], gets: [], deletes: [], analyzed: [], opens: [], searches: [] });
  st.files.clear();
  st.vision = { clip: null, dir: null, text: false, image: false, faces: false };
});

describe("moving to one model", () => {
  for (const offered of [true, false]) {
    it(`an account with only MobileCLIP's index: the indexing phone builds the new one, faces taken over, then MobileCLIP's go${offered ? "" : " (the Play build too)"}`, async () => {
      st.offered = offered;
      // a: MobileCLIP's entry with a face; b: one made without faces; c: none
      st.server.mcs2 = [
        { item_id: A, data_enc: enc({ v: 1, m: M, clip: "AQ", faces: [FACE] }), updated_at: 1 },
        { item_id: B, data_enc: enc({ v: 1, m: "mcs2/2", clip: "AQ" }), updated_at: 2 },
      ];
      await engine.startSearch(lib([A, B, C]));
      expect(engine.searchProgress()).toMatchObject({ phase: "ready" });
      expect(st.opens.at(-1)).toEqual({ clip: "clip-b32", indexes: true });
      expect(st.concepts).toBeGreaterThan(0);
      // a: only the image model, its face kept (the people document names it "a:0"); b and c: faces looked for
      expect(st.analyzed).toEqual([{ faces: false, clips: ["clip-b32"] }, { faces: true, clips: ["clip-b32"] }, { faces: true, clips: ["clip-b32"] }]);
      expect(st.puts.map((p) => [p.id, p.model])).toEqual([[A, L], [B, L], [C, L]]);
      expect(st.puts[0].faces).toEqual([FACE]);
      expect(st.deletes).toEqual(["/api/index?model=mcs2"]);
      expect(st.server.mcs2).toEqual([]);

      // the next start has nothing to do and doesn't ask for MobileCLIP's again
      st.analyzed = []; st.puts = []; st.gets = []; st.deletes = [];
      await engine.startSearch(lib([A, B, C]));
      expect(st.analyzed).toEqual([]);
      expect(st.puts).toEqual([]);
      expect(st.gets).toEqual(["laionb32"]);
      expect(st.deletes).toEqual([]);
    });
  }

  it("an account whose index explicit search made with LAION keeps it: nothing is indexed again", async () => {
    st.server.laionb32 = [A, B].map((id, i) => ({ item_id: id, data_enc: enc({ v: 1, m: L, clip: "AQ", faces: [FACE] }), updated_at: 1 + i }));
    st.clock = 5;
    await engine.startSearch(lib([A, B]));
    expect(st.analyzed).toEqual([]);
    expect(st.puts).toEqual([]);
    expect(st.gets).toEqual(["laionb32"]);
    expect(st.deletes).toEqual([]);
  });

  it("MobileCLIP's entries left for photos it can't index stay until everything is done", async () => {
    st.server.mcs2 = [{ item_id: A, data_enc: enc({ v: 1, m: M, clip: "AQ", faces: [] }), updated_at: 1 }];
    const item = { ...lib([A])[0] as object, has_thumb: false, has_preview: false, itemKey: new Uint8Array(32) };
    const other = lib([B]);
    await engine.startSearch([item, ...other] as never[]); // a can't be indexed (no picture); b can
    expect(st.puts.map((p) => p.id)).toEqual([B]);
    expect(st.deletes).toEqual(["/api/index?model=mcs2"]); // everything that can be indexed has the new entry
  });
});

describe("explicit content in search", () => {
  beforeEach(() => { st.files.set("file:///doc/models/clip-b32-tokenizer.json", "{}"); });
  const blocked = conceptData().explicit.indexOf(true); // the first explicit concept ("a photo of a naked person")
  const neutral = conceptData().explicit.indexOf(false);

  it("filtered by default: photos that look explicit are left out (native index), explicit words find nothing", async () => {
    await engine.startSearch(lib([A]));
    expect(engine.searchFiltered()).toBe(true);
    st.text = textOf(neutral);
    expect(await engine.textSearch("a photo of a person")).toEqual([{ id: "x", score: 0.3 }]);
    st.text = textOf(blocked);
    expect(await engine.textSearch("naked")).toEqual([]);
    expect(st.searches).toEqual([true]); // the blocked words never reached the index
  });

  it("not filtered where an admin allowed explicit search and the person chose it", async () => {
    st.explicit = true;
    await engine.startSearch(lib([A]));
    expect(engine.searchFiltered()).toBe(false);
    st.text = textOf(blocked);
    expect(await engine.textSearch("naked")).toHaveLength(1);
    expect(st.searches).toEqual([false]);
  });

  it("always filtered in the Play build, whatever the account chose", async () => {
    st.explicit = true; st.offered = false;
    await engine.startSearch(lib([A]));
    expect(engine.searchFiltered()).toBe(true);
    st.text = textOf(blocked);
    expect(await engine.textSearch("naked")).toEqual([]);
  });
});
