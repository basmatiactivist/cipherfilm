import { beforeEach, describe, expect, it, vi } from "vitest";

// Changing the password, making a new recovery key and deleting the account send the second step only when one was
// given (an account without two-step sign-in, or an older server, gets the same requests as before), and a wrong
// password shows here before a code is used up. A stand-in server and key material, as in auth.test.ts.
const server = vi.hoisted(() => ({ calls: [] as { method: string; path: string; body: any }[] }));

vi.mock("./api", async () => {
  const real = await vi.importActual<typeof import("./api")>("./api");
  return {
    ApiError: real.ApiError,
    setCsrf: () => {},
    dropRequests: () => {},
    api: async (method: string, path: string, body: any) => {
      server.calls.push({ method, path, body });
      if (path === "/api/me" && method === "GET") return { kdf: { ops: 3, mem: 64 << 20 }, wrapped_master_pw: "m1" };
      if (body?.code === "000000") throw new real.ApiError(403, "That code isn't right.", { code: "wrong_code" });
      return {};
    },
  };
});
vi.mock("./crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async (_s: unknown, password: string) => ({ auth: `auth:${password}`, kek: new Uint8Array([password === "right" ? 1 : 2]) }),
  unlockMasterKey: (_s: unknown, _e: string, k: Uint8Array) => { if (k[0] !== 1) throw new Error("wrong"); return new Uint8Array([9]); },
  rewrapForPassword: async (_s: unknown, _e: string, _k: Uint8Array, next: string) => ({ new_auth: `auth:${next}`, new_kdf: { ops: 3, mem: 64 << 20 }, new_wrapped_master_pw: "m2" }),
  newRecoveryKit: async () => ({ words: ["one", "two"], wrapped_master_recovery: "wr", recovery_verifier: "rv" }),
}));
vi.mock("./cache", () => ({ clearCaches: () => {} }));
vi.mock("./player", () => ({ clearPlayer: () => {} }));
vi.mock("./items", () => ({ clearUploadMemory: () => {}, forgetDecrypted: () => {} }));
vi.mock("./keep", () => ({ forgetKeptForGood: async () => {}, keepKey: async () => {}, keptKey: async () => null }));
vi.mock("./albums", () => ({ forgetAlbums: () => {} }));
vi.mock("./people/people", () => ({ clearPeople: () => {} }));
vi.mock("./tabs", () => ({ announce: () => {}, sameSession: () => true }));
vi.mock("./noticeAlerts", () => ({ forgetBrowserAlerts: () => {} }));

async function signedIn() {
  const auth = await import("./auth");
  const { mem } = await import("./state");
  mem.me = { user: { id: "u", email: "a@x.org", role: "user" }, kdf: { ops: 3, mem: 64 << 20 }, wrapped_master_pw: "m1", two_factor: true } as any;
  mem.masterKey = new Uint8Array([9]);
  return auth;
}
const sent = (path: string) => server.calls.filter((c) => c.path === path && c.method !== "GET").map((c) => c.body);

describe("the second step of a credential change", () => {
  beforeEach(() => { server.calls = []; vi.resetModules(); });

  it("changes the password with nothing, a code or a passkey", async () => {
    const auth = await signedIn();
    await auth.changePassword("right", "new one");
    await auth.changePassword("right", "new one", { code: " 123 456 " });
    await auth.changePassword("right", "new one", { code: "   " });
    await auth.changePassword("right", "new one", { passkey: { id: "k" }, code: "123456" });
    const bodies = sent("/api/auth/password");
    expect(bodies.map((b) => [b.code, b.passkey])).toEqual([[undefined, undefined], ["123 456", undefined], [undefined, undefined], [undefined, { id: "k" }]]);
    expect("code" in bodies[0] || "passkey" in bodies[0]).toBe(false);
    expect(bodies[0].current_auth).toBe("auth:right");
  });

  it("checks the password here first: no request, no code used up", async () => {
    const auth = await signedIn();
    await expect(auth.changePassword("typo", "new one", { code: "123456" })).rejects.toThrow("That password isn't right.");
    await expect(auth.deleteAccount("typo", { code: "123456" })).rejects.toThrow("That password isn't right.");
    await expect(auth.rotateRecoveryKey("typo")).rejects.toThrow("That password isn't right.");
    expect(server.calls).toEqual([]);
  });

  it("a wrong code keeps the account and the session", async () => {
    const auth = await signedIn();
    const { mem } = await import("./state");
    await expect(auth.deleteAccount("right", { code: "000000" })).rejects.toMatchObject({ status: 403, code: "wrong_code" });
    expect(mem.me).not.toBeNull();
    await auth.deleteAccount("right", { code: "123456" });
    expect(sent("/api/me")).toEqual([{ current_auth: "auth:right", code: "000000" }, { current_auth: "auth:right", code: "123456" }]);
    expect(mem.me).toBeNull();
  });

  it("sends the recovery key's second step with commit, once the words are saved", async () => {
    const auth = await signedIn();
    const kit = await auth.rotateRecoveryKey("right");
    expect(server.calls).toEqual([]);
    await expect(kit.commit({ code: "000000" })).rejects.toMatchObject({ code: "wrong_code" });
    await kit.commit({ passkey: { id: "k" } });
    await kit.commit();
    expect(sent("/api/auth/recovery-key")).toEqual([
      { current_auth: "auth:right", wrapped_master_recovery: "wr", recovery_verifier: "rv", code: "000000" },
      { current_auth: "auth:right", wrapped_master_recovery: "wr", recovery_verifier: "rv", passkey: { id: "k" } },
      { current_auth: "auth:right", wrapped_master_recovery: "wr", recovery_verifier: "rv" },
    ]);
  });
});
