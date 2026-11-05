import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A backup run uploads only into the account it was turned on for, and only to its server, and never moves the app's
// own server. Real backup, upload, api and session code; the server, the phone's storage and native modules are stand-ins.
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
  canUseBiometricAuthentication: () => false,
}));
// files in memory, by path
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return [...files.keys()].some((k) => k.startsWith(this.uri + "/")); }
    create() {}
    delete() { for (const k of [...files.keys()]) if (k.startsWith(this.uri + "/")) files.delete(k); }
  }
  class File {
    uri: string;
    constructor(parent: unknown, name: string) { this.uri = `${pathOf(parent)}/${name}`; }
    get exists() { return files.has(this.uri); }
    async text() { return files.get(this.uri)!; }
    async write(v: string) { files.set(this.uri, v); }
  }
  return { Directory, File, Paths: { document: "/doc", cache: "/cache" } };
});
vi.mock("expo-background-task", () => ({ registerTaskAsync: async () => {}, unregisterTaskAsync: async () => {}, BackgroundTaskResult: { Success: 1, Failed: 2 } }));
vi.mock("expo-task-manager", () => ({ defineTask: () => {} }));
vi.mock("react-native", () => ({ Platform: { constants: { Model: "Test" } }, AppState: { currentState: "active" } }));
vi.mock("./keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./search/background", () => ({ indexUploaded: async () => {}, runBackgroundIndex: async () => 0 }));
vi.mock("./search/settings", () => ({ loadSettings: async () => ({ enabled: false, background: false }), forgetSettings: () => {} }));
// sign-in without Argon2: the proof and the master key are fixed stand-ins
vi.mock("@crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async () => ({ auth: "proof", kek: new Uint8Array(32) }),
  unlockMasterKey: () => new Uint8Array(32).fill(1),
}));
// three 10-byte photos in one folder, MediaStore ids 1..3
vi.mock("../modules/cf-native/src/CfNativeModule", () => {
  const media = [1, 2, 3].map((id) => ({ id, uri: `content://m/${id}`, name: `IMG_${id}.jpg`, size: 10, mime: "image/jpeg" }));
  return {
    default: {
      backupState: () => ({ media: "all", online: true, unmetered: true, charging: true }),
      countFolderAfter: async (_b: string, after: number) => media.filter((m) => m.id > after).length,
      folderMedia: async (_b: string, after: number, n: number) => media.filter((m) => m.id > after).slice(0, n),
      readRange: async (_u: string, _o: number, len: number) => new Uint8Array(len),
      jpeg: async () => null,
      mediaInfo: async () => ({}),
      backupNotify: () => {}, backupNotifyCancel: () => {}, retryBackupSoon: () => {}, watchNewMedia: () => {},
      keepRunningLost: () => false, clearCookies: () => {},
    },
  };
});

// The server(s): one cookie jar, as on the phone. A sign-in replaces the session cookie.
const srv = vi.hoisted(() => ({
  cookie: "", // whose session the cookie holds
  alive: new Set<string>(), // sessions the server still accepts
  log: [] as string[],
  hook: (_method: string, _path: string, _who: string): Response | void => {},
  items: 0,
}));
vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname;
    const json = (status: number, v: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers });
    const who = srv.alive.has(srv.cookie) ? srv.cookie : "";
    const hooked = srv.hook(method, path, who);
    if (hooked) return hooked;
    if (path === "/api/setup/status") return json(200, {});
    if (path === "/api/auth/params") { srv.log.push(`${u.origin} params`); return json(200, { ops: 2, mem: 64 * 1024 * 1024 }); }
    if (path === "/api/auth/login") {
      const user = JSON.parse(init.body!).email.split("@")[0];
      srv.log.push(`${u.origin} login ${user}`);
      srv.cookie = user; srv.alive.add(user);
      return json(200, me(user));
    }
    if (!who) return json(401, { error: "signed out" });
    if (path === "/api/me") return json(200, me(who));
    if (method === "POST" && path === "/api/items") { srv.items++; const id = srv.items.toString(16).padStart(32, "0"); srv.log.push(`create ${id.slice(-2)} as ${who}`); return json(200, { id }); }
    const fin = path.match(/^\/api\/items\/0*([0-9a-f]+)\/finalize$/);
    if (fin) { srv.log.push(`finalize ${fin[1].padStart(2, "0")} as ${who}`); return json(200, {}); }
    return json(200, {});
  },
}));
const me = (user: string) => ({ user: { id: user, email: `${user}@x.test`, role: "user" }, csrf: `csrf-${user}`, kdf: { ops: 2, mem: 64 * 1024 * 1024 }, wrapped_master_pw: "", wrapped_privkey: "", pubkey: "" });

async function load() {
  vi.resetModules();
  const session = await import("./session");
  const backup = await import("./backup");
  const api = await import("./api");
  const { getSodium, b64 } = await import("@crypto/sodium");
  const s = await getSodium();
  const pubkey = b64(s, s.crypto_box_keypair().publicKey);
  return { session, backup, api, pubkey };
}

const SERVER = "https://a.test";
const config = (pubkey: string, server = SERVER) => ({ enabled: true, server, userId: "alice", email: "alice@x.test", pubkey, wifiOnly: false, chargingOnly: false, includeExisting: true, folders: { cam: { name: "Camera", after: 0 } } });

describe("automatic backup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear(); files.clear();
    store.set("cf.server", SERVER);
    Object.assign(srv, { cookie: "alice", alive: new Set(["alice"]), log: [], hook: () => {}, items: 0 });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("stops when the session ends and another account signs in while it waits for the server", async () => {
    const { session, backup, api, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    // the second file gets a busy server; while the run waits, alice's session ends and bob signs in
    srv.hook = (method, path) => (method === "POST" && path === "/api/items" && srv.items === 1 ? (srv.items++, new Response("{}", { status: 503 })) : undefined);
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(srv.log).toContain("finalize 01 as alice");
    srv.alive.delete("alice");
    await api.api("GET", "/api/items").catch(() => {}); // the app sees the session end
    expect(session.session().phase).toBe("signedOut");
    await session.login("bob@x.test", "pw");
    await vi.advanceTimersByTimeAsync(200_000);
    await run;
    expect(srv.log.filter((l) => l.endsWith("as bob"))).toEqual([]);
    const c = await backup.loadConfig();
    expect(c!.folders.cam.after).toBe(1); // only the file that reached alice's library counts as backed up
  });

  it("checks the account again after a wait, even when the app saw no change", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    srv.hook = (method, path) => {
      if (method === "POST" && path === "/api/items" && srv.items === 1) {
        srv.items++;
        srv.cookie = "bob"; srv.alive.add("bob"); // the cookie now holds another account's session
        return new Response("{}", { status: 503 });
      }
    };
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(200_000);
    await run;
    expect(srv.log.filter((l) => l.endsWith("as bob"))).toEqual([]);
    expect((await backup.loadConfig())!.folders.cam.after).toBe(1);
    expect((await backup.loadStatus()).problem).toMatch(/another account/);
  });

  it("a file the app keeps dying on is skipped after three runs, and the files after it are backed up", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    // two earlier runs ended (killed or hung) while working on file 1
    files.set("/doc/backup/status.json", JSON.stringify({ running: false, uploaded: 0, skipped: [], failures: { "1": 2 }, attempt: "1" }));
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    const st = await backup.loadStatus();
    expect(st.skipped.map((x) => x.name)).toEqual(["IMG_1.jpg"]);
    expect(st.attempt).toBeUndefined();
    expect((await backup.loadConfig())!.folders.cam.after).toBe(3);
    expect(srv.log.filter((l) => l.startsWith("finalize"))).toEqual(["finalize 01 as alice", "finalize 02 as alice"]); // files 2 and 3
  });

  it("one interrupted run counts as one try, and the file is tried again", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    files.set("/doc/backup/status.json", JSON.stringify({ running: false, uploaded: 0, skipped: [], failures: {}, attempt: "1" }));
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    const st = await backup.loadStatus();
    expect(st.skipped).toEqual([]);
    expect(st.uploaded).toBe(3);
    expect(st.failures).toEqual({});
  });

  it("counts a file as backed up only after it is confirmed it went to the account", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    // the session changes hands right after the check before the first file (the run's second /api/me)
    let mes = 0;
    srv.hook = (_m, path, who) => {
      if (path === "/api/me" && who === "alice" && ++mes === 2) { srv.cookie = "bob"; srv.alive.add("bob"); return new Response(JSON.stringify(me("alice")), { status: 200 }); }
    };
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(200_000);
    await run;
    expect(srv.log).toContain("finalize 01 as bob");
    const c = await backup.loadConfig();
    expect(c!.folders.cam.after).toBe(0);
    expect((await backup.loadStatus()).uploaded).toBe(0);
  });

  it("never changes the app's server, and a server it no longer uses gets nothing", async () => {
    const { session, backup, api, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey, "https://old.test"));
    const seen: string[] = [];
    srv.hook = (_m, path) => { seen.push(path); };
    await backup.runBackup("app");
    expect(api.server()).toBe(SERVER);
    expect(seen).toEqual([]);
    expect((await backup.loadConfig())!.enabled).toBe(false);
  });

  it("a backup run leaves the app's server and token as they are", async () => {
    const { session, backup, api, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    api.setCsrf("csrf-app");
    await backup.runBackup("app");
    expect(srv.log).toContain("finalize 03 as alice");
    expect(api.server()).toBe(SERVER);
    expect(api.csrfToken()).toBe("csrf-app");
  });
});

describe("changing the server", () => {
  beforeEach(() => {
    store.clear(); files.clear();
    store.set("cf.server", SERVER);
    Object.assign(srv, { cookie: "", alive: new Set(), log: [], hook: () => {}, items: 0 });
  });

  it("ends the old server's backup, and sign-in goes to the new server", async () => {
    const { session, backup, api, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    await session.chooseServer("new.test");
    expect(await backup.loadConfig()).toBeNull();
    api.setServer(SERVER); // whatever else moved it
    await session.login("bob@x.test", "pw");
    expect(srv.log).toEqual(["https://new.test params", "https://new.test login bob"]);
  });

  it("an address that doesn't answer leaves the app's server as it was", async () => {
    const { session, api } = await load();
    await session.start();
    srv.hook = () => { throw new TypeError("no route"); };
    await expect(session.chooseServer("nowhere.test")).rejects.toThrow();
    expect(api.server()).toBe(SERVER);
  });
});
