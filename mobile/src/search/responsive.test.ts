import { beforeEach, describe, expect, it, vi } from "vitest";

// Indexing while the app is in use: it gives the JS thread back between photos, a library refresh doesn't throw away
// what it is doing, the image models open right away on a new account, and the settings never wait for it. Real
// engine, settings and models list; the server, the phone's storage, the native models and the sealing are stand-ins.
const st = vi.hoisted(() => ({
  files: new Map<string, string>(),
  master: new Uint8Array(32).fill(7),
  vision: { clip: null as string | null, dir: null as string | null, text: false, image: false, faces: false, also: null as string | null },
  log: [] as string[], // what happened, in order: "open text", "open all", "fetch", "analyze <id>"
  analyzed: [] as string[],
  gate: null as Promise<void> | null, // holds every analysis until released
  opening: null as Promise<void> | null, // holds opening the image models until released
  lane: Promise.resolve() as Promise<void>,
  vectors: 0, // photos analyzed with the image models open
  textLater: false, // the text model isn't on the phone at unlock (still downloading), only when startSearch looks
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
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    indexLoad: async () => null,
    indexSave: async () => {},
    indexClear: () => {}, indexPut: async () => {}, indexRemove: () => {},
    visionState: () => st.vision,
    // like Vision.kt: what is open changes only once the models are open, and a text-only open closes the image side
    // (one at a time, in the order asked, as on the native side's own thread)
    visionOpen: (dir: string, faces: boolean, clip: string, indexes: boolean, also: string | null) => {
      st.log.push(indexes ? "open all" : "open text");
      st.lane = st.lane.then(async () => {
        if (indexes && st.opening) await st.opening; // (the image models: the text model opens at once)
        Object.assign(st.vision, { dir, clip, text: true, image: indexes, faces: indexes && faces, also });
      });
      return st.lane;
    },
    visionClose: () => {},
    visionAnalyze: async (_b: Uint8Array, _faces: boolean, clips: string[]) => {
      if (st.gate) await st.gate;
      if (!st.vision.image) throw new Error("search models not loaded");
      st.vectors++;
      return { clips: clips.map(() => new Uint8Array([1])) };
    },
    visionText: async () => new Uint8Array(4),
    indexSearch: async () => [],
    backupState: () => ({ unmetered: true }),
    backupNotify: () => {},
    checkModel: async () => true,
  },
}));
vi.mock("@crypto/item", () => ({ accountKeyPair: () => ({ pk: new Uint8Array(32), sk: new Uint8Array(32) }) }));
vi.mock("@crypto/search", () => ({
  openIndexEntry: () => ({ v: 1, m: "mcs2/2", clip: "AQ" }),
  sealIndexEntry: () => new Uint8Array(1),
  decryptPeople: () => ({}),
}));
vi.mock("../api", () => ({
  api: async (method: string, path: string) => {
    if (path.startsWith("/api/index")) { st.log.push("fetch"); return { entries: [], next: "", now: 1, count: 0 }; }
    if (method === "PUT" && path.endsWith("/index")) return {};
    return {};
  },
  ApiError: class extends Error {},
  server: () => "https://a.test",
}));
vi.mock("../session", () => ({
  onWipe: () => {},
  refreshMe: async () => null,
  session: () => ({ me: { user: { id: "alice", email: "alice@x.test" }, wrapped_privkey: "", pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", session_id: "s", indexer: "s" }, masterKey: st.master }),
}));
vi.mock("../store", () => ({ explicitSearchOffered: () => false }));
vi.mock("../library", () => ({
  imageBytes: async (it: { id: string }) => { st.log.push(`analyze ${it.id}`); st.analyzed.push(it.id); return new Uint8Array(4); },
}));
vi.mock("../prints", () => ({ fingerprint: async () => "" }));
vi.mock("../keepAlive", () => ({ keepRunning: () => true, letGo: () => {}, onlyHolder: () => true }));
vi.mock("./models", async (orig) => ({ ...(await orig<typeof import("./models")>()), haveModels: async (_f: boolean, _c: string, indexes = true) => indexes || !st.textLater, downloadModels: async () => {}, dropOtherModels: () => [] }));
vi.mock("./tokenizer", () => ({ Tokenizer: class { encode() { return [1]; } } }));

const engine = await import("./engine");
const settings = await import("./settings");
const lib = (ids: string[]) => ids.map((id) => ({ id, kind: "image", size: 1, segment_count: 1, created_at: 0, has_thumb: true, has_preview: true, itemKey: new Uint8Array(32) })) as never[];
const ids = (n: number, p = "i") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(31, "0")}`);
const until = async (f: () => boolean) => { for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 0)); };

describe("indexing while the app is in use", () => {
  beforeEach(async () => {
    await engine.forgetSearch(false);
    st.files.clear();
    st.files.set("file:///doc/search/settings.json", JSON.stringify({ enabled: true, faces: false, background: false, asked: true }));
    settings.forgetSettings(); // (only empties the cache here: the stand-in folder never exists)
    st.files.set("file:///doc/search/settings.json", JSON.stringify({ enabled: true, faces: false, background: false, asked: true }));
    Object.assign(st, { log: [], analyzed: [], gate: null, opening: null, lane: Promise.resolve(), vectors: 0, textLater: false });
    st.vision = { clip: null, dir: null, text: false, image: false, faces: false, also: null };
  });

  it("lets timers run between photos: the JS thread is never held for more than one photo per worker", async () => {
    const n = 120;
    // a timer that keeps setting itself again notes how many photos were analyzed each time it gets to run
    const seen: number[] = [];
    let on = true;
    const tick = () => { seen.push(st.analyzed.length); if (on) setTimeout(tick, 0); };
    setTimeout(tick, 0);
    await engine.startSearch(lib(ids(n)));
    on = false;
    expect(st.analyzed).toHaveLength(n);
    expect(engine.searchProgress()).toMatchObject({ phase: "ready", done: n, total: n });
    const steps = seen.slice(1).map((v, i) => v - seen[i]);
    expect(seen.filter((v) => v < n).length).toBeGreaterThanOrEqual(n / 2); // the timer ran while it indexed
    expect(Math.max(...steps)).toBeLessThanOrEqual(2); // two workers, each at most one photo between two ticks
  });

  it("on a new account, opens the image models at once, next to fetching the server's entries", async () => {
    let release = () => {};
    st.opening = new Promise((r) => { release = r; });
    const run = engine.startSearch(lib(ids(3)));
    await until(() => st.log.includes("fetch"));
    expect(st.log).toContain("open all"); // asked for, and still opening while the entries come
    expect(st.vision.image).toBe(false);
    release();
    await run;
    expect(st.analyzed).toHaveLength(3);
  });

  it("a search while the image models are still opening doesn't close them again", async () => {
    let release = () => {};
    st.opening = new Promise((r) => { release = r; });
    st.textLater = true; // right after the download: nothing open yet, all of it opens in one go
    const run = engine.startSearch(lib(ids(3)));
    await until(() => engine.searchReady()); // the entries are in while the models still open
    expect(st.vision.image).toBe(false);
    st.files.set("file:///doc/models/mobileclip-s2-tokenizer.json", "{}");
    const found = engine.textSearch("dog");
    release();
    await Promise.all([run, found]);
    // opened once: not closed by the search and opened again (seconds, on a phone)
    expect(st.log.filter((x) => x.startsWith("open"))).toEqual(["open all"]);
    expect(st.vectors).toBe(3);
    expect(st.vision.image).toBe(true);
    expect(engine.searchProgress()).toMatchObject({ phase: "ready", done: 3, total: 3 });
  });

  it("the settings load and save while a photo is being analyzed", async () => {
    let release = () => {};
    st.gate = new Promise((r) => { release = r; });
    const run = engine.startSearch(lib(ids(4)));
    await until(() => st.analyzed.length > 0);
    expect(engine.searchProgress().phase).toBe("indexing");
    // the analysis is held: neither of these may wait for it
    const read = await Promise.race([settings.loadSettings().then(() => "read"), new Promise((r) => setTimeout(() => r("waited"), 50))]);
    expect(read).toBe("read");
    const saved = await Promise.race([settings.saveSettings({ chargingOnly: false }).then(() => "saved"), new Promise((r) => setTimeout(() => r("waited"), 50))]);
    expect(saved).toBe("saved");
    release();
    await run;
    expect(engine.searchProgress().phase).toBe("ready");
  });

  it("a library refresh while indexing doesn't start over: the new photos go first, nothing is done twice", async () => {
    let release = () => {};
    st.gate = new Promise((r) => { release = r; });
    const first = ids(6);
    const run = engine.startSearch(lib(first));
    await until(() => st.analyzed.length >= 2);
    const added = ids(2, "n");
    await engine.libraryChanged(lib([...added, ...first])); // newest first, as the library is
    release();
    await run;
    await until(() => engine.searchProgress().phase === "ready" && st.analyzed.length === 8);
    expect([...st.analyzed].sort()).toEqual([...first, ...added].sort()); // each once: the run wasn't thrown away
    expect(st.analyzed.slice(2, 4).sort()).toEqual(added.sort()); // right after the two that were going
    expect(engine.searchProgress()).toMatchObject({ phase: "ready", total: 8 });
  });

  it("with nothing running, a library refresh starts search", async () => {
    await engine.libraryChanged(lib(ids(2)));
    expect(st.analyzed).toHaveLength(2);
  });
});
