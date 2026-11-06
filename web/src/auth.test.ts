import { beforeEach, describe, expect, it, vi } from "vitest";

// A small in-memory server and stand-in key material: what matters here is which keys end up stored and which
// recovery words the person is shown, not the cryptography itself.
const server = vi.hoisted(() => ({
  user: null as null | { email: string; bundle: Record<string, string> },
  loseNextResponse: false,
  loginDown: false,
  hangLogout: false,
  dropped: 0,
}));
let made = 0;

vi.mock("./api", () => ({
  setCsrf: () => {},
  dropRequests: () => { server.dropped++; },
  api: async (method: string, path: string, body: any) => {
    const me = () => ({ csrf: "c", user: { id: "u", email: server.user!.email, role: "admin" }, wrapped_master_pw: server.user!.bundle.wrapped_master_pw });
    if (path === "/api/setup") {
      if (server.user) throw new Error("setup is already done");
      server.user = { email: body.email, bundle: body };
      if (server.loseNextResponse) { server.loseNextResponse = false; throw new Error("network error"); }
      return me();
    }
    if (path.startsWith("/api/auth/params")) {
      if (server.loginDown) { server.loginDown = false; throw new Error("network error"); }
      return { alg: "argon2id13", v: 1, ops: 3, mem: 64 << 20, salt: "x" };
    }
    if (path === "/api/auth/login") {
      if (server.user?.bundle.auth !== body.auth) throw new Error("wrong password");
      return me();
    }
    if (path === "/api/auth/logout") return server.hangLogout ? new Promise(() => {}) : {};
    throw new Error(`unexpected ${method} ${path}`);
  },
}));
vi.mock("./crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  createAccount: async (_s: unknown, _email: string, password: string) => {
    const n = ++made;
    return { bundle: { auth: `auth:${password}`, wrapped_master_pw: `m${n}`, recovery_verifier: `r${n}` }, masterKey: new Uint8Array([n]), recoveryWords: [`word${n}`] };
  },
  loginProof: async (_s: unknown, password: string) => ({ auth: `auth:${password}`, kek: new Uint8Array() }),
  unlockMasterKey: (_s: unknown, _e: string, _k: Uint8Array, wrapped: string) => new Uint8Array([Number(wrapped.slice(1))]),
}));
vi.mock("./cache", () => ({ clearCaches: () => {} }));
vi.mock("./player", () => ({ clearPlayer: () => {} }));
vi.mock("./items", () => ({ clearUploadMemory: () => {}, forgetDecrypted: () => {} }));

const storedWords = () => `word${server.user!.bundle.recovery_verifier.slice(1)}`;

describe("creating the first account when a response is lost", () => {
  beforeEach(() => {
    server.user = null;
    server.loseNextResponse = false;
    server.loginDown = false;
    vi.resetModules();
  });

  it("a retry of the same form shows the recovery words the server stored", async () => {
    const { setup } = await import("./auth");
    server.loseNextResponse = true; // stored, but the reply never arrives...
    server.loginDown = true; // ...and neither does the check
    await expect(setup("tok", "a@x.org", "pw")).rejects.toThrow();
    const key = await setup("tok", "a@x.org", "pw");
    expect(key.words).toEqual([storedWords()]);
  });

  it("never shows words the server doesn't have, even after a reload", async () => {
    server.loseNextResponse = true;
    server.loginDown = true;
    await expect((await import("./auth")).setup("tok", "a@x.org", "pw")).rejects.toThrow();
    vi.resetModules(); // a reload forgets the first attempt's keys
    await expect((await import("./auth")).setup("tok", "a@x.org", "pw")).rejects.toThrow(/already exists/);
  });
});

describe("signing out", () => {
  beforeEach(() => {
    server.user = null;
    server.hangLogout = false;
    server.dropped = 0;
    vi.resetModules();
  });

  it("forgets the keys before the server answers, even if it never does", async () => {
    const { setup, logout } = await import("./auth");
    const { mem } = await import("./state");
    await (await setup("tok", "a@x.org", "pw")).commit();
    expect(mem.masterKey).not.toBeNull();
    server.hangLogout = true; // a slow or unreachable server
    void logout();
    expect(mem.masterKey).toBeNull();
    expect(mem.me).toBeNull();
    expect(server.dropped).toBe(1); // requests still on their way are dropped
  });
});
