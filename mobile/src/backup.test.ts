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
// which runs asked for the foreground service, and which build this is (Google Play or GitHub)
const held = vi.hoisted(() => ({ runs: [] as string[], play: false }));
vi.mock("./keepAlive", () => ({ keepRunning: (h: string) => { held.runs.push(h); return false; }, letGo: () => {}, onlyHolder: () => false }));
vi.mock("./store", () => ({ isPlayBuild: () => held.play }));
vi.mock("./search/background", () => ({ indexUploaded: async () => {}, rememberUploaded: async () => {}, runBackgroundIndex: async () => 0 }));
vi.mock("./search/settings", () => ({ loadSettings: async () => ({ enabled: false, background: false }), forgetSettings: () => {} }));
// sign-in without Argon2: the proof and the master key are fixed stand-ins
vi.mock("@crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async () => ({ auth: "proof", kek: new Uint8Array(32) }),
  unlockMasterKey: () => new Uint8Array(32).fill(1),
}));
// what the notification showed: [title, text, ongoing]
const notes = vi.hoisted(() => [] as [string, string, boolean][]);
// three 10-byte photos in one folder, MediaStore ids 1..3 (reset before each test)
const media = vi.hoisted(() => [] as { id: number; uri: string; name: string; size: number; mime: string }[]);
vi.mock("../modules/cf-native/src/CfNativeModule", () => {
  return {
    default: {
      backupState: () => ({ media: "all", online: true, unmetered: true, charging: true }),
      countFolderAfter: async (_b: string, after: number) => media.filter((m) => m.id > after).length,
      folderMedia: async (_b: string, after: number, n: number) => media.filter((m) => m.id > after).slice(0, n),
      readRange: async (_u: string, _o: number, len: number) => new Uint8Array(len),
      jpeg: async () => null,
      mediaInfo: async () => ({}),
      backupNotify: (title: string, text: string, _p: number, ongoing: boolean) => { notes.push([title, text, ongoing]); }, backupNotifyCancel: () => {}, retryBackupSoon: () => {}, watchNewMedia: () => {},
      keepRunningLost: () => false, clearCookies: () => {},
    },
  };
});

const KDF = vi.hoisted(() => ({ alg: "argon2id13", v: 1, ops: 2, mem: 64 * 1024 * 1024, salt: "AAAAAAAAAAAAAAAAAAAAAA" }));

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
    if (path === "/api/auth/params") { srv.log.push(`${u.origin} params`); return json(200, KDF); }
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
const me = (user: string) => ({ user: { id: user, email: `${user}@x.test`, role: "user" }, csrf: `csrf-${user}`, kdf: KDF, wrapped_master_pw: "", wrapped_privkey: "", pubkey: "" });

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
    notes.length = 0;
    media.splice(0, media.length, ...[1, 2, 3].map((id) => ({ id, uri: `content://m/${id}`, name: `IMG_${id}.jpg`, size: 10, mime: "image/jpeg" })));
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

  it("can't be turned on for the public demo login, and says why", async () => {
    const { backup, pubkey } = await load();
    const demo = { ...me("demo"), pubkey, demo: true };
    await expect(backup.enableBackup(demo, SERVER, new Uint8Array(32), { wifiOnly: false, chargingOnly: false, includeExisting: true, folders: {} })).rejects.toThrow(/public demo/);
    expect(await backup.loadConfig()).toBeNull();
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

  it("with nothing waiting, a run doesn't ask the server, so a server that is down is no problem then", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig({ ...config(pubkey), folders: { cam: { name: "Camera", after: 3 } } });
    let asked = 0;
    srv.hook = () => { asked++; throw new TypeError("fetch failed"); };
    const run = backup.runBackup("background");
    await vi.advanceTimersByTimeAsync(200_000);
    await run;
    expect(asked).toBe(0);
    expect((await backup.loadStatus()).problem).toBeUndefined();
  });

  it("an empty file (0 bytes) is skipped at once and named, and the files after it are backed up", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    media[0].size = 0;
    const run = backup.runBackup("app");
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    const st = await backup.loadStatus();
    expect(st.skipped).toEqual([{ name: "IMG_1.jpg", reason: "The file is empty (0 bytes)." }]);
    expect(st.problem).toBeUndefined();
    expect(srv.log.filter((l) => l.startsWith("create"))).toHaveLength(2); // no empty item in the library
    expect((await backup.loadConfig())!.folders.cam.after).toBe(3);
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

  it("skips what the backup's own account has, never what another account's library has", async () => {
    const { session, backup, pubkey } = await load();
    const { fingerprint } = await import("./prints");
    await session.start();
    await backup.saveConfig(config(pubkey));
    await backup.rememberLibrary("bob", [{ meta: { name: "IMG_1.jpg", size: 10 } }]);
    expect(files.has("/doc/backup/known.json")).toBe(false);
    // a list written for another account (by an older version) is not used either
    files.set("/doc/backup/known.json", JSON.stringify({ userId: "bob", prints: [await fingerprint("IMG_2.jpg", 10)] }));
    await backup.runBackup("app");
    expect(srv.log.filter((l) => l.startsWith("finalize"))).toHaveLength(3);
    expect(JSON.parse(files.get("/doc/backup/known.json")!).userId).toBe("alice");
  });

  it("the Google Play build holds the foreground service only for Back up now", async () => {
    for (const [play, trigger, holds] of [[true, "app", false], [true, "background", false], [true, "manual", true], [false, "background", true]] as const) {
      const { session, backup, pubkey } = await load();
      await session.start();
      await backup.saveConfig(config(pubkey));
      held.runs = []; held.play = play;
      await backup.runBackup(trigger);
      expect(held.runs.includes("backup"), `${play ? "play" : "github"} ${trigger}`).toBe(holds);
      expect(srv.log.filter((l) => l.startsWith("finalize"))).toHaveLength(3); // it backs up either way
      held.play = false;
    }
  });

  it("on Google Play, a file too big for an automatic run waits for Back up now; the rest goes on", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    held.play = true;
    // file 2 takes longer than an automatic run may last (no foreground service there)
    let slow = true;
    srv.hook = (method, path) => { if (slow && method === "PUT" && /\/items\/0+2\/segments\/0$/.test(path)) vi.setSystemTime(Date.now() + 20 * 60_000); };
    await backup.runBackup("background");
    let st = await backup.loadStatus();
    expect(st.needsYou?.map((w) => w.name)).toEqual(["IMG_2.jpg"]);
    expect(st.failures).toEqual({}); // not counted as a failure: it isn't one
    expect(notes.some(([title]) => title === "A large video is waiting")).toBe(true);
    expect(await backup.waitingCount()).toBe(2); // file 3 and the big one
    // the next automatic run goes past it
    await backup.runBackup("background");
    expect(srv.log.filter((l) => l.startsWith("finalize")).map((l) => l.split(" ")[1])).toEqual(["01", "03"]); // 02 was the aborted try
    // Back up now uploads it, and skips what is already there
    slow = false;
    await backup.runBackup("manual");
    st = await backup.loadStatus();
    expect(st.needsYou).toBeUndefined();
    expect(srv.log.filter((l) => l.startsWith("finalize")).map((l) => l.split(" ")[1])).toEqual(["01", "03", "04"]);
    expect(await backup.waitingCount()).toBe(0);
    held.play = false;
  });

  it("skips a photo the account's library already has", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    await backup.rememberLibrary("alice", [{ meta: { name: "IMG_1.jpg", size: 10 } }]);
    await backup.runBackup("app");
    expect(srv.log.filter((l) => l.startsWith("finalize"))).toEqual(["finalize 01 as alice", "finalize 02 as alice"]); // files 2 and 3
    expect((await backup.loadConfig())!.folders.cam.after).toBe(3);
  });

  it("says which file the last run stopped on until a run gets past it", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    files.set("/doc/backup/status.json", JSON.stringify({ running: false, uploaded: 0, skipped: [], failures: {}, attempt: "1", current: "IMG_1.jpg" }));
    srv.hook = (_m, path) => (path === "/api/me" ? new Response("{}", { status: 401 }) : undefined);
    await backup.runBackup("app");
    expect((await backup.loadStatus()).stalled).toBe("IMG_1.jpg"); // this run never reached it
    srv.hook = () => {};
    await backup.runBackup("app");
    expect((await backup.loadStatus()).stalled).toBeUndefined();
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

  // The reported case: backup turned on with "only new", some photos already in the library and others not. The
  // screen said "Everything is backed up" and choosing "also the ones already there" afterwards changed nothing.
  it("says which older photos aren't backed up, and backs them up once asked to", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig({ ...config(pubkey), includeExisting: false, folders: { cam: { name: "Camera", after: 3 } } });
    await backup.rememberLibrary("alice", [{ meta: { name: "IMG_1.jpg", size: 10 } }]);
    expect(await backup.waitingCount()).toBe(0);
    expect(await backup.notBackedUp()).toBe(2); // IMG_2 and IMG_3: not "everything"
    const cur = (await backup.loadConfig())!;
    await backup.saveConfig({ ...cur, includeExisting: true, folders: backup.chooseFolders(cur, ["cam"], true, [{ id: "cam", name: "Camera", newest: 3 }]) });
    expect(await backup.waitingCount()).toBe(3);
    await backup.runBackup("app");
    expect(srv.log.filter((l) => l.startsWith("finalize"))).toEqual(["finalize 01 as alice", "finalize 02 as alice"]); // files 2 and 3 only
    expect(await backup.notBackedUp()).toBe(0);
    expect((await backup.loadConfig())!.folders.cam.after).toBe(3);
  });

  it("applies \"photos already on the phone\" to every chosen folder, and keeps the place of the rest", async () => {
    const { backup } = await load();
    const phone = [{ id: "cam", name: "Camera", newest: 90 }, { id: "shots", name: "Screenshots", newest: 50 }];
    const cur = { ...config("pk"), includeExisting: false, folders: { cam: { name: "Camera", after: 40 } } };
    expect(backup.chooseFolders(cur, ["cam", "shots"], false, phone)).toEqual({ cam: { name: "Camera", after: 40 }, shots: { name: "Screenshots", after: 50 } });
    expect(backup.chooseFolders(cur, ["cam", "shots"], true, phone)).toEqual({ cam: { name: "Camera", after: 0 }, shots: { name: "Screenshots", after: 0 } });
    const all = { ...cur, includeExisting: true, folders: { cam: { name: "Camera", after: 10 } } };
    expect(backup.chooseFolders(all, ["cam"], false, phone)).toEqual({ cam: { name: "Camera", after: 90 } });
  });

  it("a run keeps what the person changed meanwhile: a folder added, backup turned off", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    const edit = (f: (c: ReturnType<typeof config>) => void) => {
      const c = JSON.parse(files.get("/doc/backup/config.json")!);
      f(c);
      files.set("/doc/backup/config.json", JSON.stringify(c));
    };
    let finals = 0;
    srv.hook = (_m, path) => {
      if (!path.endsWith("/finalize")) return;
      if (++finals === 1) edit((c) => { (c.folders as Record<string, { name: string; after: number }>).shots = { name: "Screenshots", after: 7 }; });
      if (finals === 2) edit((c) => { c.enabled = false; });
    };
    await backup.runBackup("app");
    const c = (await backup.loadConfig())!;
    expect(c.enabled).toBe(false); // not switched back on by the run
    expect(c.folders).toEqual({ cam: { name: "Camera", after: 1 }, shots: { name: "Screenshots", after: 7 } });
    expect(srv.log.filter((l) => l.startsWith("finalize"))).toHaveLength(2); // stopped once it was turned off
  });

  it("shows one notification that follows the files, then one summary", async () => {
    const { session, backup, pubkey } = await load();
    await session.start();
    await backup.saveConfig(config(pubkey));
    await backup.runBackup("app");
    const ongoing = notes.filter((n) => n[2]);
    expect(ongoing.map((n) => n[0])).toEqual(["Backing up 1 of 3", "Backing up 2 of 3", "Backing up 3 of 3"]);
    expect(ongoing.map((n) => n[1])).toEqual(["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"]);
    expect(notes.filter((n) => !n[2])).toEqual([["Backup done", "3 photos and videos backed up.", false]]);
  });

  it("the summary says what couldn't be backed up, and nothing when nothing happened", async () => {
    const { backup } = await load();
    expect(backup.backupSummary(0, 0, "Waiting for Wi-Fi.")).toBeNull();
    expect(backup.backupSummary(1, 0)).toEqual({ title: "Backup done", text: "1 photo or video backed up." });
    expect(backup.backupSummary(4, 2, "Your storage on the server is full.")).toEqual({ title: "Backup incomplete", text: "4 photos and videos backed up. 2 couldn't be backed up. Stopped: Your storage on the server is full." });
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
