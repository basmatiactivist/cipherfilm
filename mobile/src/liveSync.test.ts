import { beforeEach, describe, expect, it, vi } from "vitest";

// What a live update loads again on the phone: only what the ping names and the phone has loaded; the library waits
// for the phone's own uploads to finish. Stores, uploads and search are stand-ins.
const st = vi.hoisted(() => ({
  calls: [] as string[], uploads: 0, idle: [] as (() => void)[], libraryLoaded: true, albumsLoaded: true, indexes: false,
}));
vi.mock("./api", () => ({ api: async () => ({}) }));
vi.mock("./live", async () => ({ coalesce: (await vi.importActual<typeof import("./live")>("./live")).coalesce, watchLive: () => {} }));
vi.mock("./libraryStore", () => ({
  libraryItems: () => [{ id: "a" }], libraryLoaded: () => st.libraryLoaded,
  refreshLibrary: async (o: { quiet?: boolean }) => { st.calls.push(o?.quiet ? "library quiet" : "library"); },
}));
vi.mock("./albumsStore", () => ({ albumsLoaded: () => st.albumsLoaded, refreshAlbums: async () => { st.calls.push("albums"); } }));
vi.mock("./upload", () => ({ uploadsRunning: () => st.uploads, onUploadsIdle: (f: () => void) => { st.idle.push(f); } }));
vi.mock("./noticesStore", () => ({ refreshNotices: async () => { st.calls.push("notices"); } }));
vi.mock("./search/people", () => ({ peopleChanged: () => { st.calls.push("people"); } }));
vi.mock("./search/engine", () => ({ startSearch: async () => { st.calls.push("search"); }, thisPhoneIndexes: () => st.indexes }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo/fetch", () => ({ fetch: async () => { throw new Error("none"); } }));

describe("liveSync", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { calls: [], uploads: 0, idle: [], libraryLoaded: true, albumsLoaded: true, indexes: false });
  });

  it("loads what the ping names, quietly", async () => {
    const m = await import("./liveSync");
    const trash = vi.fn();
    const off = m.onTrashChanged(trash);
    await m.sync(new Set(["items", "trash", "albums", "people"]));
    expect(st.calls).toEqual(["library quiet", "albums", "people"]);
    expect(trash).toHaveBeenCalledTimes(1);
    off();
    await m.sync(new Set(["trash"]));
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("loads the notices when they changed", async () => {
    const m = await import("./liveSync");
    await m.sync(new Set(["notices"]));
    expect(st.calls).toEqual(["notices"]);
  });

  it("leaves alone what this phone hasn't loaded", async () => {
    const m = await import("./liveSync");
    st.libraryLoaded = false; st.albumsLoaded = false;
    await m.sync(new Set(["items", "albums"]));
    expect(st.calls).toEqual([]);
  });

  it("the library waits for this phone's uploads, then loads once", async () => {
    vi.useFakeTimers();
    const m = await import("./liveSync");
    m.startLiveSync();
    st.uploads = 2;
    await m.sync(new Set(["items"]));
    expect(st.calls).toEqual([]);
    st.uploads = 0;
    st.idle.forEach((f) => f());
    await vi.advanceTimersByTimeAsync(1000);
    expect(st.calls).toEqual(["library quiet"]);
    vi.useRealTimers();
  });

  it("the search index: only on a phone that doesn't index, and at most every 30 s", async () => {
    const m = await import("./liveSync");
    await m.sync(new Set(["index"]));
    await m.sync(new Set(["index"]));
    expect(st.calls).toEqual(["search"]);
    st.indexes = true;
    vi.resetModules();
    const again = await import("./liveSync");
    await again.sync(new Set(["index"]));
    expect(st.calls).toEqual(["search"]);
  });
});
