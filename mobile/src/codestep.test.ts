import { beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in's code step (session.ts): nothing of the account before the code is right, the key derived from the
// password kept for a wrong code and wiped when the sign-in expired or the person starts over. Crypto and the
// server are stand-ins.
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
  canUseBiometricAuthentication: () => false,
}));
const kek = vi.hoisted(() => ({ current: new Uint8Array(0) }));
vi.mock("@crypto/sodium", () => ({ getSodium: async () => ({ memzero: (b: Uint8Array) => b.fill(0) }), b64: () => "", unb64: () => new Uint8Array() }));
vi.mock("@crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async () => { kek.current = new Uint8Array([9, 9, 9]); return { auth: "AUTH", kek: kek.current }; },
  unlockMasterKey: () => new Uint8Array([1, 2, 3]),
}));
vi.mock("@crypto/wrap", () => ({ open: () => new Uint8Array(), LABEL: {} }));
// Android's passkey dialog: answers whatever challenge it is given
vi.mock("./passkeys", () => ({ getPasskey: async (o: { challenge: string }) => ({ id: "k", answered: o.challenge }) }));
const srv = vi.hoisted(() => ({ calls: [] as { path: string; body: any }[], answers: [] as (() => any)[] }));
class ApiError extends Error { constructor(public status: number, m: string, public detail = "", public code = "", public body: unknown = null) { super(m); } }
vi.mock("./api", () => ({
  ApiError,
  setCsrf: () => {}, setServer: () => {}, whenSessionEnds: () => {}, whenRevoked: () => {}, remote: () => ({}),
  api: async (_m: string, path: string, body: any) => {
    srv.calls.push({ path, body });
    if (path.startsWith("/api/auth/params")) return { alg: "argon2id13", v: 1, ops: 3, mem: 64 << 20, salt: "AAAAAAAAAAAAAAAAAAAAAA" };
    const next = srv.answers.shift();
    if (!next) throw new Error("unexpected " + path);
    return next();
  },
}));

const bundle = { user: { id: "u1", email: "a@x.org", role: "user" }, csrf: "c", kdf: {}, wrapped_master_pw: "w", wrapped_privkey: "", pubkey: "" };
const twoFactor = () => { throw new ApiError(401, "two-step", "", "two_factor_required", { pending: "PENDING", expires_in: 300 }); };

describe("sign-in with a code", () => {
  beforeEach(() => { vi.resetModules(); srv.calls = []; srv.answers = []; });

  it("signs in without a code when the account has none", async () => {
    const s = await import("./session");
    srv.answers.push(() => bundle);
    expect(await s.login("a@x.org", "pw")).toBeNull();
    expect(s.session().phase).toBe("unlocked");
    expect([...kek.current]).toEqual([0, 0, 0]);
  });

  it("waits for the code: wrong keeps the step, right signs in", async () => {
    const s = await import("./session");
    srv.answers.push(twoFactor);
    const step = await s.login("a@x.org", "pw");
    expect(step).not.toBeNull();
    expect(s.session().me).toBeNull(); // nothing of the account yet
    expect([...kek.current]).toEqual([9, 9, 9]);
    srv.answers.push(() => { throw new ApiError(401, "x", "", "wrong_code"); });
    await expect(step!.finish("000000")).rejects.toThrow(/isn't right/);
    expect([...kek.current]).toEqual([9, 9, 9]); // kept for the next try
    srv.answers.push(() => bundle);
    await step!.finish("123456");
    expect(srv.calls.at(-1)).toEqual({ path: "/api/auth/login/2fa", body: { pending: "PENDING", code: "123456" } });
    expect(s.session().phase).toBe("unlocked");
    expect([...kek.current]).toEqual([0, 0, 0]);
  });

  it("an expired sign-in wipes the key and asks for the password again", async () => {
    const s = await import("./session");
    srv.answers.push(twoFactor);
    const step = (await s.login("a@x.org", "pw"))!;
    srv.answers.push(() => { throw new ApiError(401, "x", "", "two_factor_expired"); });
    await expect(step.finish("123456")).rejects.toBeInstanceOf(s.CodeExpired);
    expect([...kek.current]).toEqual([0, 0, 0]);
    await expect(step.finish("123456")).rejects.toBeInstanceOf(s.CodeExpired); // not sent again
    expect(srv.calls.filter((c) => c.path === "/api/auth/login/2fa").length).toBe(1);
  });

  it("starting over wipes the key", async () => {
    const s = await import("./session");
    srv.answers.push(twoFactor);
    const step = (await s.login("a@x.org", "pw"))!;
    step.cancel();
    expect([...kek.current]).toEqual([0, 0, 0]);
    expect(s.session().phase).not.toBe("unlocked");
  });

  it("a wrong password is no code step", async () => {
    const s = await import("./session");
    srv.answers.push(() => { throw new ApiError(401, "Wrong e-mail or password.", "", ""); });
    await expect(s.login("a@x.org", "pw")).rejects.toThrow(/Wrong e-mail/);
    expect([...kek.current]).toEqual([0, 0, 0]);
  });

  it("a passkey instead of the code: its answer to this sign-in's challenge, nothing of the account before", async () => {
    const s = await import("./session");
    srv.answers.push(() => { throw new ApiError(401, "two-step", "", "two_factor_required", { pending: "PENDING", expires_in: 300, totp: false, passkey: true }); });
    const step = (await s.login("a@x.org", "pw"))!;
    expect(step.passkey).toBe(true);
    expect(step.totp).toBe(false);
    srv.answers.push(() => ({ options: { challenge: "c1", rpId: "photos.test" } }));
    srv.answers.push(() => { throw new ApiError(401, "x", "", "wrong_passkey"); });
    await expect(step.usePasskey()).rejects.toThrow(/wasn't accepted/);
    expect(s.session().me).toBeNull();
    expect([...kek.current]).toEqual([9, 9, 9]); // kept for the next try
    srv.answers.push(() => ({ options: { challenge: "c2", rpId: "photos.test" } }));
    srv.answers.push(() => bundle);
    await step.usePasskey();
    const sent = srv.calls.filter((c) => c.path === "/api/auth/login/2fa").map((c) => c.body);
    expect(sent).toEqual([{ pending: "PENDING", passkey: { id: "k", answered: "c1" } }, { pending: "PENDING", passkey: { id: "k", answered: "c2" } }]);
    expect(s.session().phase).toBe("unlocked");
    expect([...kek.current]).toEqual([0, 0, 0]);
  });

  it("an older server names no second step: the code is asked for", async () => {
    const s = await import("./session");
    srv.answers.push(twoFactor);
    const step = (await s.login("a@x.org", "pw"))!;
    expect(step.totp).toBe(true);
    expect(step.passkey).toBe(false);
  });
});
