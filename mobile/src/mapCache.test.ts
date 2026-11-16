import { beforeEach, describe, expect, it, vi } from "vitest";

// MapLibre's cache of map images (where the map was looked at) outlives the app's process: a lock, a sign-out or the
// map turned off clears it also in a run that showed no map, as long as one was shown since it was last cleared.
const st = vi.hoisted(() => ({ files: new Set<string>(), clears: 0, wipe: [] as ((how: string) => void)[] }));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    get exists() { return st.files.has(this.uri); }
    write() { st.files.add(this.uri); }
    delete() { st.files.delete(this.uri); }
  }
  return { File, Paths: { document: "/doc" } };
});
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock("@maplibre/maplibre-react-native", () => ({ OfflineManager: { clearAmbientCache: async () => { st.clears++; } } }));
vi.mock("./session", () => ({ session: () => ({ me: { user: { id: "u1" } } }), onWipe: (f: (how: string) => void) => st.wipe.push(f) }));
vi.mock("./store", () => ({ privacyUrl: () => "https://example.test/privacy" }));

const fresh = async () => { vi.resetModules(); st.wipe = []; st.clears = 0; return import("./mapConsent"); };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the map's cache", () => {
  beforeEach(() => { st.files.clear(); });

  it("a run that shows no map leaves MapLibre alone when no map was ever shown", async () => {
    const m = await fresh();
    await m.clearMapCache();
    for (const f of st.wipe) f("ended");
    await m.setMapOn(false);
    await flush();
    expect(st.clears).toBe(0);
  });

  it("is cleared in the next run, map or not, after a map was shown and the app ended before a clear", async () => {
    let m = await fresh();
    await m.mapCacheReady(); // a map shows; the app is then ended before it locks
    expect(st.files.has("/doc/map-cache-used")).toBe(true);

    for (const how of ["ended", "locked"]) {
      m = await fresh(); // the next start: no map shown in this run
      for (const f of st.wipe) f(how);
      await flush();
      expect(st.clears, how).toBe(1);
      expect(st.files.has("/doc/map-cache-used")).toBe(false);
      st.files.add("/doc/map-cache-used");
    }

    m = await fresh();
    await m.setMapOn(false);
    await flush();
    expect(st.clears).toBe(1);
    expect(st.files.has("/doc/map-cache-used")).toBe(false);
  });

  it("keeps the mark while a map shown in this run may still be loading", async () => {
    const m = await fresh();
    await m.mapCacheReady();
    for (const f of st.wipe) f("locked");
    await flush();
    expect(st.clears).toBe(2);
    expect(st.files.has("/doc/map-cache-used")).toBe(true);
  });
});
