import { beforeEach, describe, expect, it, vi } from "vitest";

// The backup and the background search index never use the master key: they go on when the app locks during a run,
// and the background task does both while the app is locked. Real session (with every wipe a lock runs), backup,
// upload, background indexing and API code; the server, the phone's storage and the native modules are stand-ins.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
  canUseBiometricAuthentication: () => false,
}));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(pathOf).join("/"); }
    get exists() { return [...files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    delete() { for (const k of [...files.keys()]) if (k.startsWith(this.uri + "/")) files.delete(k); }
    list() { return []; }
  }
  class File {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(pathOf).join("/"); }
    get exists() { return files.has(this.uri); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/"))); }
    async text() { return files.get(this.uri)!; }
    textSync() { return files.get(this.uri)!; }
    async write(v: string) { files.set(this.uri, v); }
    delete() { files.delete(this.uri); }
  }
  return { Directory, File, Paths: { document: "/doc", cache: "/cache" } };
});
const task = vi.hoisted(() => ({ run: null as null | (() => Promise<unknown>) }));
vi.mock("expo-background-task", () => ({ registerTaskAsync: async () => {}, unregisterTaskAsync: async () => {}, BackgroundTaskResult: { Success: 1, Failed: 2 } }));
vi.mock("expo-task-manager", () => ({ defineTask: (_: string, f: () => Promise<unknown>) => { task.run = f; } }));
vi.mock("expo-sharing", () => ({ clearSharedPayloads: () => {} }));
vi.mock("react-native", () => ({ Platform: { constants: { Model: "Test" } }, AppState: { currentState: "background" } }));
vi.mock("./keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./search/models", () => ({
  haveModels: async () => true, modelPath: () => "/doc/models", family: () => "mcs2",
  modelTag: (_c: string, f: boolean) => (f ? "mcs2+yunet23+sface21/2" : "mcs2/2"), dropOtherModels: () => [],
  STANDARD: "mobileclip-s2", keepsStandard: () => false, toCompute: () => ["mobileclip-s2"],
}));
vi.mock("@crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async () => ({ auth: "proof", kek: new Uint8Array(32) }),
  unlockMasterKey: () => new Uint8Array(32).fill(1),
}));
// three photos in the backup's folder; the first is in the library already and has no search entry yet
const media = vi.hoisted(() => [1, 2, 3].map((id) => ({ id, uri: `content://m/${id}`, name: `IMG_${id}.jpg`, size: 10, mime: "image/jpeg" })));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    backupState: () => ({ media: "full", online: true, unmetered: true, charging: true }),
    countFolderAfter: async (_b: string, after: number) => media.filter((m) => m.id > after).length,
    folderMedia: async (_b: string, after: number, n: number) => media.filter((m) => m.id > after).sort((a, b) => a.id - b.id).slice(0, n), // by id, as MediaStore gives them
    phoneMedia: async () => media,
    readRange: async (_u: string, _o: number, len: number) => new Uint8Array(len),
    jpeg: async () => ({ bytes: new Uint8Array(4), width: 1, height: 1 }),
    mediaInfo: async () => ({}),
    visionOpen: async () => {}, visionClose: () => {}, visionAnalyze: async () => ({ clips: [new Uint8Array(8)] }),
    backupNotify: () => {}, backupNotifyCancel: () => {}, retryBackupSoon: () => {}, watchNewMedia: () => {},
    keepRunningLost: () => false, clearCookies: () => {},
    // what a lock wipes
    forgetThumbs: () => {}, forgetVideos: () => {}, thumbsClearImages: () => {}, indexClear: () => {}, revokeShared: () => {},
  },
}));
const srv = vi.hoisted(() => ({ log: [] as string[], items: 0, hook: (_m: string, _p: string) => {} }));
vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    srv.hook(method, path);
    if (path === "/api/auth/params") return json({ alg: "argon2id13", v: 1, ops: 2, mem: 64 * 1024 * 1024, salt: "AAAAAAAAAAAAAAAAAAAAAA" });
    if (path === "/api/auth/login" || path === "/api/me") return json(me);
    if (method === "POST" && path === "/api/items") { srv.items++; return json({ id: srv.items.toString(16).padStart(32, "0") }); }
    const done = path.match(/^\/api\/items\/0*([0-9a-f]+)\/(finalize|index)$/);
    if (done) srv.log.push(`${done[2]} ${done[1]}`);
    return json({});
  },
}));
const me = { user: { id: "alice", email: "alice@x.test", role: "user" }, csrf: "c", kdf: { alg: "argon2id13", v: 1, ops: 2, mem: 64 * 1024 * 1024, salt: "AAAAAAAAAAAAAAAAAAAAAA" }, wrapped_master_pw: "", wrapped_privkey: "", pubkey: "" };

const SERVER = "https://a.test";
const INDEXED = "ff".repeat(16); // the library's copy of IMG_1, for the background index

async function load() {
  vi.resetModules();
  const session = await import("./session");
  // every module that wipes something at a lock, as in the app
  await Promise.all([import("./library"), import("./libraryStore"), import("./albumsStore"), import("./outbox"), import("./pending"), import("./viewerList"), import("./search/engine"), import("./search/people")]);
  const backup = await import("./backup");
  const { getSodium, b64 } = await import("@crypto/sodium");
  const { fingerprint } = await import("./prints");
  const s = await getSodium();
  const pubkey = b64(s, s.crypto_box_keypair().publicKey);
  await backup.saveConfig({ enabled: true, server: SERVER, userId: "alice", email: "alice@x.test", pubkey, wifiOnly: false, chargingOnly: false, includeExisting: true, folders: { cam: { name: "Camera", after: 0 } } });
  await backup.rememberLibrary("alice", [{ meta: { name: "IMG_1.jpg", size: 10 } }]);
  files.set("/doc/search/settings.json", JSON.stringify({ enabled: true, background: true, chargingOnly: false, faces: false, asked: true, server: SERVER, userId: "alice", pubkey, clip: "mobileclip-s2", indexes: true }));
  files.set("/doc/search/local.json", JSON.stringify({ userId: "alice", prints: { [await fingerprint("IMG_1.jpg", 10)]: INDEXED }, done: [] }));
  await session.start();
  await session.login("alice@x.test", "pw");
  expect(session.session().phase).toBe("unlocked");
  return { session, backup };
}

describe("while the app is locked", () => {
  beforeEach(() => {
    store.clear(); files.clear();
    store.set("cf.server", SERVER);
    Object.assign(srv, { log: [], items: 0, hook: () => {} });
  });

  it("the background task backs up and indexes", async () => {
    const { session } = await load();
    session.lock();
    expect(session.session()).toMatchObject({ phase: "locked", masterKey: null });
    expect(await task.run!()).toBe(1); // Success
    // IMG_2 and IMG_3 (at once), each indexed once counted; then the library's IMG_1, which had no entry
    expect(srv.log).toEqual(["finalize 1", "finalize 2", "index 1", "index 2", `index ${INDEXED}`]);
    expect(session.session().phase).toBe("locked");
  });

  it("a backup run goes on when the app locks during it", async () => {
    const { session, backup } = await load();
    srv.hook = (_m, path) => { if (path.endsWith("/finalize")) session.lock(); };
    await backup.runBackup("app");
    expect(session.session().phase).toBe("locked");
    expect(srv.log).toEqual(["finalize 1", "finalize 2", "index 1", "index 2"]);
    expect((await backup.loadConfig())!.folders.cam.after).toBe(3);
    expect((await backup.loadStatus()).problem).toBeUndefined();
  });
});
