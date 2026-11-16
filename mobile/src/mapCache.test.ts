import { beforeEach, describe, expect, it, vi } from "vitest";

// MapLibre's cache of map images (where the map was looked at) outlives the app's process: a lock, a sign-out or the
// map turned off clears it also in a run that showed no map, as long as one was shown since it was last cleared.
const st = vi.hoisted(() => ({ files: new Set<string>(), clears: 0, wipe: [] as ((how: string) => void)[], transforms: [] as { id?: string; match?: string; find: string; replace: string }[] }));
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
vi.mock("@maplibre/maplibre-react-native", () => ({
  OfflineManager: { clearAmbientCache: async () => { st.clears++; } },
  TransformRequestManager: { addUrlTransform: (o: { id?: string; match?: string; find: string; replace: string }) => { st.transforms.push(o); return o.id; } },
}));
vi.mock("./session", () => ({ session: () => ({ me: { user: { id: "u1" }, map: { light: ["https://maps.example.test/light.json"], dark: ["https://maps.example.test:8443/dark.json"] } } }), onWipe: (f: (how: string) => void) => st.wipe.push(f) }));
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

describe("the hosts the map loads from", () => {
  it("only those the question before the map named; everything else goes nowhere", async () => {
    const m = await fresh();
    st.transforms = [];
    await m.mapCacheReady();
    expect(st.transforms).toHaveLength(1);
    const [tr] = st.transforms;
    expect(tr).toMatchObject({ id: "cf-map-hosts", find: "^.+$", replace: "https://127.0.0.1:9/" });
    const blocked = (u: string) => new RegExp(tr.match!).test(u);
    expect(blocked("https://maps.example.test/light.json")).toBe(false);
    expect(blocked("https://maps.example.test/tiles/5/16/11.pbf")).toBe(false);
    expect(blocked("https://maps.example.test:8443/dark.json")).toBe(false);
    expect(blocked("https://maps.example.test:8443")).toBe(false);
    // a style naming tiles, fonts or icons on another host, a look-alike, another port, plain http
    expect(blocked("https://other.example.test/tiles/5/16/11.pbf")).toBe(true);
    expect(blocked("https://maps.example.test.other.test/x")).toBe(true);
    expect(blocked("https://maps.example.test@other.test/x")).toBe(true);
    expect(blocked("https://maps.example.test:9999/x")).toBe(true);
    expect(blocked("https://mapsXexample.test/x")).toBe(true);
    expect(blocked("http://maps.example.test/x")).toBe(true);
    // the replacement itself is never let through to anywhere but this phone
    expect(blocked("https://127.0.0.1:9/")).toBe(true);
  });

  it("with no map hosts (or none that is a plain host name) nothing is allowed", async () => {
    const m = await fresh();
    for (const hosts of [[], ["bad host"], ["a.test/x"]]) expect(new RegExp(m.outsideHosts(hosts)).test("https://a.test/x"), hosts.join()).toBe(true);
    expect(new RegExp(m.outsideHosts(["A.test:443"])).test("https://a.test/x")).toBe(false);
  });
});
