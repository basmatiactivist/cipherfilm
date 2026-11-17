import { beforeEach, describe, expect, it, vi } from "vitest";

// A phone signed out from another device (or after a password change or an admin turning the account off) forgets the
// key behind the fingerprint too, also when it learns it before /api/me answered (the app's start) or in a background
// run, where no account is loaded and the app's server isn't set. Another server's answer changes nothing.
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
  canUseBiometricAuthentication: () => false,
}));
vi.mock("expo-sharing", () => ({ clearSharedPayloads: () => {} }));
vi.mock("expo-file-system", () => ({ Directory: class { exists = false; delete() {} create() {} }, File: class {}, Paths: { cache: "/cache" } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: { thumbsPrefetch: () => {}, thumbsClearImages: () => {}, forgetThumbs: () => {} } }));
vi.mock("./backup", () => ({ rememberLibrary: async () => {} }));
vi.mock("./keepAlive", () => ({ keepRunning: () => true, letGo: () => {}, onlyHolder: () => false }));

const net = vi.hoisted(() => ({
  base: "",
  me: "ok" as "ok" | "expired",
  revoked: (_origin: string) => {},
  ended: () => {},
}));
vi.mock("./api", () => {
  class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
  return {
    ApiError,
    newSignIn: () => {},
    setCsrf: () => {},
    setServer: (o: string) => { net.base = o; },
    server: () => net.base,
    whenSessionEnds: (f: () => void) => { net.ended = f; },
    whenRevoked: (f: (o: string) => void) => { net.revoked = f; },
    getBytes: async () => new Uint8Array(),
    api: async (_m: string, path: string) => {
      if (path === "/api/me") {
        if (net.me === "expired") throw new ApiError(401, "signed out");
        return { user: { id: "alice", email: "alice@x.org", role: "user" }, csrf: "c", kdf: {}, wrapped_master_pw: "", wrapped_privkey: "", pubkey: "" };
      }
      throw new Error("unexpected " + path);
    },
  };
});

const SERVER = "https://photos.example.test";
const fingerprintKeys = () => ["cf.mk.alice", "cf.bio.alice"].filter((k) => store.has(k));
const settle = () => new Promise((r) => setTimeout(r, 0));

async function fresh() {
  vi.resetModules();
  net.base = "";
  net.me = "ok";
  return import("./session");
}

describe("signed out from elsewhere", () => {
  beforeEach(() => {
    store.clear();
    store.set("cf.server", SERVER);
    store.set("cf.user", "alice"); // the last start remembered whose keys these are
    store.set("cf.mk.alice", "key");
    store.set("cf.bio.alice", "1");
    store.set("cf.bioNo.alice", "1");
  });

  it("a start that learns it before /api/me answered still deletes the fingerprint key", async () => {
    const session = await fresh();
    net.revoked(SERVER); // what api.ts does on the revoked answer to the start's /api/me
    await settle();
    expect(fingerprintKeys()).toEqual([]);
    expect(store.has("cf.bioNo.alice")).toBe(false);
    expect(store.has("cf.user")).toBe(false);
    expect(session.session().masterKey).toBeNull();
  });

  it("a background run (no account loaded, the app's server not set) deletes it for the stored server", async () => {
    await fresh();
    expect(net.base).toBe("");
    net.revoked(SERVER + "/"); // its own Remote; trailing slash or not
    await settle();
    expect(fingerprintKeys()).toEqual([]);
  });

  it("another server's revoked answer deletes nothing", async () => {
    await fresh();
    net.revoked("https://elsewhere.example.test");
    await settle();
    expect(fingerprintKeys()).toEqual(["cf.mk.alice", "cf.bio.alice"]);
  });

  it("a session that expired while the app was closed takes the fingerprint key with it, not the 'Not now'", async () => {
    const session = await fresh();
    net.me = "expired";
    await session.start();
    expect(session.session().phase).toBe("signedOut");
    expect(fingerprintKeys()).toEqual([]);
    expect(store.get("cf.bioNo.alice")).toBe("1");
  });

  it("a start remembers whose keys are on the phone", async () => {
    store.delete("cf.user");
    const session = await fresh();
    await session.start();
    await settle();
    expect(store.get("cf.user")).toBe("alice");
    expect(fingerprintKeys()).toEqual(["cf.mk.alice", "cf.bio.alice"]); // nothing ended
  });

  it("a background run's sign-out is finished at the next start by the parts of the app that run didn't load", async () => {
    let session = await fresh();
    net.revoked(SERVER); // a background run: only the backup loaded
    await settle();
    expect(store.get("cf.teardown")).toBe("1");

    // the next start, with the whole app: a part that wasn't loaded then (screenshots, auto-lock) deletes its part now
    session = await fresh();
    const done: string[] = [];
    session.onSignOut(() => { done.push("signOut"); });
    session.onWipe((how) => { done.push(`wipe ${how}`); });
    net.me = "expired"; // its cookie went with the sign-out
    await session.start();
    expect(done).toEqual(["wipe ended", "signOut"]);
    expect(store.has("cf.teardown")).toBe(false);
    expect(session.session().phase).toBe("signedOut");

    // once done, a later start deletes nothing more (someone may have signed in since)
    session = await fresh();
    done.length = 0;
    session.onSignOut(() => { done.push("signOut"); });
    net.me = "ok";
    await session.start();
    expect(done).toEqual([]);
  });

  it("with the app on screen, the sign-out is complete at once and nothing is left for the next start", async () => {
    const session = await fresh();
    await session.start();
    net.revoked(SERVER);
    await settle();
    expect(store.has("cf.teardown")).toBe(false);
    expect(fingerprintKeys()).toEqual([]);
  });
});
