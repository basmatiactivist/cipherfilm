import { beforeEach, describe, expect, it, vi } from "vitest";

// Where archived and locked items show. The library store splits locked items off right after decrypting: the list
// every screen reads (the grid, search, albums, favorites, people, the map, duplicates) never holds one; only the
// locked folder takes them, after its check, and a lock empties both. Archived items stay in the shared list (search,
// albums, favorites) but not in the main grid or On this day. Server, decryption, session and the phone's check are
// stand-ins.
const st = vi.hoisted(() => ({
  master: new Uint8Array(32).fill(1) as Uint8Array | null,
  wipes: [] as (() => void)[],
  list: [] as any[],
  remembered: [] as string[],
  level: 3,
  auth: { success: true } as { success: boolean; error?: string },
  asked: 0,
  password: "",
}));
const appState = vi.hoisted(() => ({ listeners: [] as ((s: string) => void)[] }));
vi.mock("react-native", () => ({ AppState: { addEventListener: (_e: string, f: (s: string) => void) => { appState.listeners.push(f); return { remove() {} }; } } }));
vi.mock("react", () => ({ useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }));
vi.mock("expo-file-system", () => ({ File: class { exists = false; textSync() { return ""; } }, Directory: class {}, Paths: {} }));
vi.mock("./session", () => ({
  session: () => ({ me: { user: { id: "alice" } }, masterKey: st.master }),
  onWipe: (f: () => void) => { st.wipes.push(f); },
  passwordProof: async (p: string) => { if (p !== st.password) throw new Error("That password isn't right."); return "auth"; },
}));
vi.mock("./library", () => ({
  loadCachedLibrary: async () => null,
  loadLibrary: async () => st.list,
  thumbBytes: async () => new Uint8Array([1, 2]),
  prefetchThumbs: () => {}, pruneCache: () => {}, forgetLists: () => {},
}));
vi.mock("./backup", () => ({ rememberLibrary: async (_u: string, items: { id: string }[]) => { st.remembered = items.map((i) => i.id); } }));
vi.mock("./search/engine", () => ({ startSearch: async () => {}, libraryChanged: async () => {}, warmSearch: async () => {} }));
vi.mock("./api", () => ({ api: async () => ({}) }));
vi.mock("./autolock", () => ({ away: (f: () => unknown) => f() }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: { base64: () => "AQI=", forgetVideos: () => {} } }));
vi.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: async () => st.level,
  authenticateAsync: async () => { st.asked++; return st.auth; },
}));

const YEAR = 365 * 86_400_000;
const item = (id: string, extra: object = {}, meta: object = {}) => ({
  id, kind: "image", size: 1, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, favorite: true, itemKey: new Uint8Array(32).fill(3),
  meta: { name: `${id}.jpg`, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: Date.now() - 2 * YEAR, ...meta }, ...extra,
});
const ids = (l: { id: string }[] | null | undefined) => (l ?? []).map((i) => i.id).sort();
const lock = () => { st.master = null; st.wipes.forEach((f) => f()); };

describe("archived and locked items in the app's lists", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(st, { master: new Uint8Array(32).fill(1), wipes: [], remembered: [], level: 3, auth: { success: true }, asked: 0, password: "" });
    st.list = [item("plain"), item("old", {}, { archived: true }), item("secret", {}, { locked: true }), item("both", {}, { archived: true, locked: true })];
  });

  it("no screen's list holds a locked item; archived ones are out of the main grid and On this day only", async () => {
    const store = await import("./libraryStore");
    const { mainGrid, archived } = await import("@edit/folders");
    const { memoriesFrom } = await import("./memories");
    await store.refreshLibrary();
    const shared = store.useLibrary().items!;
    // what search, albums, favorites, people, the map and duplicates read
    expect(ids(shared)).toEqual(["old", "plain"]);
    expect(ids(store.libraryItems())).toEqual(["old", "plain"]);
    expect(ids(shared.filter((i) => i.favorite))).toEqual(["old", "plain"]); // favorites (all four are favorites)
    const album = new Set(["plain", "old", "secret"]); // an album still holding a locked item
    expect(ids(shared.filter((i) => album.has(i.id)))).toEqual(["old", "plain"]);
    // the main grid and On this day
    expect(ids(mainGrid(shared))).toEqual(["plain"]);
    expect(ids(memoriesFrom(shared).flatMap((m) => m.items))).toEqual(["plain"]);
    expect(ids(archived(shared))).toEqual(["old"]);
    // only the locked folder's source has them (locked wins over archived)
    expect(ids(store.lockedItems())).toEqual(["both", "secret"]);
    // the backup still knows them, so it doesn't upload them again
    await new Promise((r) => setTimeout(r, 1600));
    expect(st.remembered.sort()).toEqual(["both", "old", "plain", "secret"]);
  });

  it("the locked folder shows them only after the phone's check, every time, and forgets them when left", async () => {
    const store = await import("./libraryStore");
    const folder = await import("./lockedFolder");
    await store.refreshLibrary();
    expect(folder.useLockedFolder()).toEqual({ open: false, items: null });
    expect(folder.lockedFolderItems()).toEqual([]);
    st.auth = { success: false, error: "user_cancel" };
    expect(await folder.deviceCheck()).toBe("failed");
    st.auth = { success: true };
    expect(await folder.deviceCheck()).toBe("passed");
    folder.openLockedFolder();
    expect(ids(folder.useLockedFolder().items)).toEqual(["both", "secret"]);
    const secret = folder.lockedFolderItems().find((i) => i.id === "secret")!;
    expect(await folder.lockedThumbUri(secret)).toBe("data:image/jpeg;base64,AQI=");
    folder.closeLockedFolder();
    expect(folder.useLockedFolder()).toEqual({ open: false, items: null });
    expect(await folder.lockedThumbUri(secret)).toBeNull(); // closed: nothing decrypted
    expect(await folder.deviceCheck()).toBe("passed");
    expect(st.asked).toBe(3); // asked each time, never remembered
    // the app going to the background closes it, also without a lock
    folder.openLockedFolder();
    expect(folder.useLockedFolder().open).toBe(true);
    for (const f of appState.listeners) f("inactive");
    expect(folder.useLockedFolder().open).toBe(true);
    for (const f of appState.listeners) f("background");
    expect(folder.useLockedFolder()).toEqual({ open: false, items: null });
  });

  it("asks for the account password where the phone has no fingerprint or screen lock, checked on the phone", async () => {
    const folder = await import("./lockedFolder");
    st.level = 0;
    expect(await folder.deviceCheck()).toBe("password");
    expect(st.asked).toBe(0);
    st.password = "right";
    await expect(folder.passwordCheck("wrong")).rejects.toThrow(/isn't right/);
    await expect(folder.passwordCheck("right")).resolves.toBeUndefined();
  });

  it("a lock empties the locked store and closes the folder, with its decrypted thumbnails", async () => {
    const store = await import("./libraryStore");
    const folder = await import("./lockedFolder");
    await store.refreshLibrary();
    folder.openLockedFolder();
    const secret = folder.lockedFolderItems()[0];
    await folder.lockedThumbUri(secret);
    lock();
    expect(folder.useLockedFolder()).toEqual({ open: false, items: null });
    expect(folder.lockedFolderItems()).toEqual([]);
    expect(store.lockedItems()).toEqual([]);
    expect(store.libraryItems()).toEqual([]);
    expect(secret.itemKey!.every((b) => b === 0)).toBe(true); // its key zeroed with the list
    expect(() => folder.openLockedFolder()).toThrow(/Unlock/);
  });

  it("follows changes while open: an item moved out leaves the folder", async () => {
    const store = await import("./libraryStore");
    const folder = await import("./lockedFolder");
    await store.refreshLibrary();
    folder.openLockedFolder();
    st.list = [item("plain"), item("secret"), item("both", {}, { locked: true })];
    await store.refreshLibrary(); // (the folder's own quiet reload at opening may still run: this one follows it)
    await new Promise((r) => setTimeout(r, 10));
    expect(ids(folder.useLockedFolder().items)).toEqual(["both"]);
    expect(ids(store.libraryItems())).toEqual(["plain", "secret"]);
  });
});
