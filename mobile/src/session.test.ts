import { beforeEach, describe, expect, it, vi } from "vitest";

// What the app knows after the library was unlocked must be gone once it is locked, signed out or the session ends,
// and must never be shown to another account. Native modules and the server are stand-ins.
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
  canUseBiometricAuthentication: () => false,
}));
const shared = vi.hoisted(() => ({ payloads: 1 }));
vi.mock("expo-sharing", () => ({ clearSharedPayloads: () => { shared.payloads = 0; } }));
vi.mock("expo-file-system", () => ({ Directory: class { exists = false; delete() {} create() {} }, File: class {}, Paths: { cache: "/cache" } }));
// the native thumbnails: what they were told to forget
const native = vi.hoisted(() => ({ forgot: 0 }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: { thumbsPrefetch: () => {}, thumbsClearImages: () => {}, forgetThumbs: () => { native.forgot++; } },
}));
vi.mock("./backup", () => ({ rememberLibrary: async () => {} }));
vi.mock("./keepAlive", () => ({ keepRunning: () => true, letGo: () => {}, onlyHolder: () => false }));
const server = vi.hoisted(() => ({ user: "alice" }));
vi.mock("./api", () => ({
  setCsrf: () => {},
  setServer: () => {},
  whenSessionEnds: () => {},
  whenRevoked: () => {},
  ApiError: class extends Error {},
  getBytes: async () => new Uint8Array(),
  api: async (_m: string, path: string) => {
    if (path === "/api/me") return { user: { id: server.user, email: `${server.user}@x.org`, role: "user" }, csrf: "c", kdf: {}, wrapped_master_pw: "", wrapped_privkey: "", pubkey: "" };
    if (path === "/api/auth/logout") return {};
    throw new Error("unexpected " + path);
  },
}));
// the decrypted list: two items with keys, as loadLibrary would return them
vi.mock("./library", async (orig) => {
  const real = await orig<typeof import("./library")>();
  return { ...real, loadLibrary: async () => [{ id: "a1", itemKey: new Uint8Array([7, 7]), meta: { name: "x.jpg" } }, { id: "a2", itemKey: new Uint8Array([8]) }] };
});

async function unlockedAs(user: string) {
  vi.resetModules();
  server.user = user;
  shared.payloads = 1;
  const session = await import("./session");
  const libraryStore = await import("./libraryStore");
  await import("./pending");
  await session.start(); // locked: session known, no key
  (session as any).__testUnlock?.();
  return { session, libraryStore };
}

describe("ending or locking a session", () => {
  beforeEach(() => { store.clear(); store.set("cf.server", "https://example.test"); });

  it("a lock forgets the decrypted library and zeroes its item keys", async () => {
    const { session, libraryStore } = await unlockedAs("alice");
    const mod = session as any;
    mod.session().masterKey = new Uint8Array(32).fill(1); mod.session().phase = "unlocked";
    await libraryStore.refreshLibrary();
    const items = libraryStore.libraryItems();
    expect(items).toHaveLength(2);
    native.forgot = 0;
    session.lock();
    expect(libraryStore.libraryItems()).toHaveLength(0);
    expect([...items[0].itemKey!]).toEqual([0, 0]);
    expect(native.forgot).toBeGreaterThan(0); // the native thumbnail keys and bitmaps too
    expect(shared.payloads).toBe(1); // a lock keeps a waiting share: it continues after unlocking
  });

  it("a sign-out also drops a waiting share, so the next account never receives it", async () => {
    const { session, libraryStore } = await unlockedAs("alice");
    const mod = session as any;
    mod.session().masterKey = new Uint8Array(32).fill(1); mod.session().phase = "unlocked";
    await libraryStore.refreshLibrary();
    await session.signOut();
    expect(libraryStore.libraryItems()).toHaveLength(0);
    expect(shared.payloads).toBe(0);
  });

  it("a list loaded for one account is never shown to another", async () => {
    const { session, libraryStore } = await unlockedAs("alice");
    const mod = session as any;
    mod.session().masterKey = new Uint8Array(32).fill(1); mod.session().phase = "unlocked";
    await libraryStore.refreshLibrary();
    mod.session().me = { ...mod.session().me, user: { id: "bob" } };
    expect(libraryStore.libraryItems()).toHaveLength(0);
  });
});

describe("password-hashing settings from the server", () => {
  const good = { alg: "argon2id13" as const, v: 1 as const, ops: 3, mem: 256 * 1024 * 1024, salt: "AAAAAAAAAAAAAAAAAAAAAA" };

  it("takes the usual settings and refuses anything else before a password is hashed", async () => {
    const { assertSaneKdf } = await import("./session");
    expect(() => assertSaneKdf(good)).not.toThrow();
    for (const bad of [
      { ...good, alg: "argon2i13" }, { ...good, v: 2 }, { ...good, ops: 1 }, { ...good, ops: 2.5 }, { ...good, mem: 16 * 1024 * 1024 },
      { ...good, mem: "268435456" }, { ...good, salt: "AAAA" }, { ...good, salt: "AAAAAAAAAAAAAAAAAAAAA=" }, { ...good, salt: undefined },
    ]) expect(() => assertSaneKdf(bad as any), JSON.stringify(bad)).toThrow(/unexpected password settings/);
  });
});
