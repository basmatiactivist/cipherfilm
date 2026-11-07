import { beforeEach, describe, expect, it, vi } from "vitest";

// A lock while the library or the albums load: the answer that arrives after it is dropped quietly (no error banner
// after unlocking), and that load doesn't keep the next one from starting. Server, decryption and session are stand-ins.
const st = vi.hoisted(() => ({
  master: new Uint8Array(32).fill(1) as Uint8Array | null,
  wipes: [] as (() => void)[],
  gate: null as Promise<void> | null,
  loads: 0,
}));
// the stores' hooks read their snapshot directly here
vi.mock("react", () => ({ useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }));
vi.mock("./session", () => ({
  session: () => ({ me: { user: { id: "alice" } }, masterKey: st.master }),
  onWipe: (f: () => void) => { st.wipes.push(f); },
}));
// a load that waits at the gate, then fails as the real one does when the key went meanwhile
async function slow<T>(v: T): Promise<T> {
  st.loads++;
  const at = st.master;
  if (st.gate) await st.gate;
  if (!at || st.master !== at) throw new Error("Unlock your library first.");
  return v;
}
vi.mock("./library", () => ({
  loadCachedLibrary: async () => null,
  loadLibrary: () => slow([{ id: "a" }]),
  prefetchThumbs: () => {}, pruneCache: () => {},
}));
vi.mock("./albums", () => ({ loadAlbums: () => slow([{ id: "x", name: "Trip", itemIds: [] }]) }));
vi.mock("./backup", () => ({ rememberLibrary: async () => {} }));
vi.mock("./search/engine", () => ({ startSearch: async () => {}, warmSearch: async () => {} }));
vi.mock("./api", () => ({ api: async () => ({}) }));

const lock = () => { st.master = null; st.wipes.forEach((f) => f()); };
const unlock = () => { st.master = new Uint8Array(32).fill(2); };
function gated() {
  let open!: () => void;
  st.gate = new Promise((r) => { open = r; });
  return open;
}

describe("a lock while loading", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { master: new Uint8Array(32).fill(1), wipes: [], gate: null, loads: 0 });
  });

  it("the library: the late answer shows no error, and the load after unlocking runs", async () => {
    const m = await import("./libraryStore");
    const open = gated();
    const first = m.refreshLibrary();
    lock();
    open();
    await first;
    expect(m.useLibrary()).toMatchObject({ items: null, error: undefined, loading: false });
    unlock();
    await m.refreshLibrary();
    expect(st.loads).toBe(2);
    expect(m.useLibrary()).toMatchObject({ items: [{ id: "a" }], error: undefined, loading: false });
  });

  it("the library: a load still waiting doesn't block the one after unlocking", async () => {
    const m = await import("./libraryStore");
    const open = gated();
    const first = m.refreshLibrary();
    lock();
    unlock();
    st.gate = null;
    await m.refreshLibrary();
    expect(st.loads).toBe(2);
    expect(m.useLibrary().items).toEqual([{ id: "a" }]);
    open();
    await first;
    expect(m.useLibrary()).toMatchObject({ items: [{ id: "a" }], error: undefined, loading: false });
  });

  it("the albums: the late answer shows no error, and the load after unlocking runs", async () => {
    const m = await import("./albumsStore");
    const open = gated();
    const first = m.refreshAlbums();
    lock();
    unlock();
    st.gate = null;
    await m.refreshAlbums();
    open();
    await first;
    expect(st.loads).toBe(2);
    expect(m.useAlbums()).toMatchObject({ albums: [{ id: "x", name: "Trip", itemIds: [] }], error: undefined, loading: false });
  });
});

// Live updates (live.ts) load the lists quietly, and a change that comes in while a load runs is not lost.
describe("quiet loads and loads asked for meanwhile", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { master: new Uint8Array(32).fill(1), wipes: [], gate: null, loads: 0 });
  });

  it("the library: a quiet load shows no spinner, and one asked for while it runs runs once after it", async () => {
    const m = await import("./libraryStore");
    expect(m.libraryLoaded()).toBe(false);
    const open = gated();
    const first = m.refreshLibrary({ quiet: true });
    expect(m.useLibrary().loading).toBe(false);
    expect(m.libraryLoaded()).toBe(true);
    m.refreshLibrary({ quiet: true });
    m.refreshLibrary({ quiet: true });
    st.gate = null;
    open();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(st.loads).toBe(2);
    expect(m.useLibrary()).toMatchObject({ items: [{ id: "a" }], loading: false });
  });

  it("the library: a quiet load that fails leaves no error banner", async () => {
    const m = await import("./libraryStore");
    st.master = null; // fails as a load does without the key
    await m.refreshLibrary({ quiet: true });
    expect(m.useLibrary().error).toBeUndefined();
  });

  it("the albums: the same", async () => {
    const m = await import("./albumsStore");
    expect(m.albumsLoaded()).toBe(false);
    const open = gated();
    const first = m.refreshAlbums({ quiet: true });
    expect(m.useAlbums().loading).toBe(false);
    m.refreshAlbums();
    expect(m.useAlbums().loading).toBe(true); // asked for by hand: the spinner shows
    st.gate = null;
    open();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(st.loads).toBe(2);
    expect(m.albumsLoaded()).toBe(true);
  });
});
