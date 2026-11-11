import { beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in of an account with two-step sign-in: the password step gives no session and no keys, only a pending
// token; the code step finishes it. A stand-in server and key material, as in auth.test.ts.
const server = vi.hoisted(() => ({ calls: [] as string[], csrf: [] as string[] }));
const kek = vi.hoisted(() => ({ last: null as Uint8Array | null }));

vi.mock("./api", async () => {
  const real = await vi.importActual<typeof import("./api")>("./api");
  return {
    ApiError: real.ApiError,
    setCsrf: (c: string) => { server.csrf.push(c); },
    dropRequests: () => {},
    api: async (method: string, path: string, body: any) => {
      server.calls.push(path);
      if (path.startsWith("/api/auth/params")) return { alg: "argon2id13", v: 1, ops: 3, mem: 64 << 20, salt: "x" };
      if (path === "/api/auth/login") {
        if (body.auth !== "auth:right") throw new real.ApiError(401, "Wrong e-mail or password.", { error: "wrong e-mail or password" });
        throw new real.ApiError(401, "This account uses two-step sign-in.", { error: "x", code: "two_factor_required", pending: "pend-1", expires_in: 300 });
      }
      if (path === "/api/auth/login/2fa") {
        if (body.pending !== "pend-1") throw new real.ApiError(401, "Expired.", { code: "two_factor_expired" });
        if (body.code === "123456" || body.code === "abcd-efgh-jkmn-pqrs") return { csrf: "c2", session_id: "s", user: { id: "u", email: "a@x.org", role: "user" }, wrapped_master_pw: "m9" };
        if (body.code === "999999") throw new real.ApiError(401, "Expired.", { code: "two_factor_expired" });
        throw new real.ApiError(401, "That code isn't right.", { code: "wrong_code" });
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
});
vi.mock("./crypto/account", () => ({
  normEmail: (e: string) => e.trim().toLowerCase(),
  loginProof: async (_s: unknown, password: string) => { kek.last = new Uint8Array([7, 7, 7]); return { auth: `auth:${password}`, kek: kek.last }; },
  unlockMasterKey: (_s: unknown, _e: string, k: Uint8Array, wrapped: string) => { if (!k.some((b) => b)) throw new Error("zeroed key"); return new Uint8Array([Number(wrapped.slice(1))]); },
}));
vi.mock("./cache", () => ({ clearCaches: () => {} }));
vi.mock("./player", () => ({ clearPlayer: () => {} }));
vi.mock("./items", () => ({ clearUploadMemory: () => {}, forgetDecrypted: () => {} }));

describe("two-step sign-in", () => {
  beforeEach(() => { server.calls = []; server.csrf = []; vi.resetModules(); });

  it("signs in only after the code; nothing of the account before", async () => {
    const auth = await import("./auth");
    const { mem } = await import("./state");
    const step = await auth.login("A@x.org", "right");
    expect(step).not.toBeNull();
    expect(mem.me).toBeNull();
    expect(mem.masterKey).toBeNull();
    expect(server.csrf).toEqual([]);
    // a wrong code: try again with the same step
    await expect(step!.finish("000000")).rejects.toThrow(/isn't right/);
    expect(kek.last!.some((b) => b)).toBe(true);
    expect(mem.me).toBeNull();
    await step!.finish(" 123456 ");
    expect(server.calls.filter((p) => p === "/api/auth/login/2fa").length).toBe(2);
    expect(mem.me?.user.id).toBe("u");
    expect(Array.from(mem.masterKey!)).toEqual([9]);
    expect(kek.last!.every((b) => b === 0)).toBe(true); // the password-derived key is gone
    await expect(step!.finish("123456")).rejects.toBeInstanceOf(auth.CodeExpired);
  });

  it("an expired sign-in goes back to the password and forgets the key", async () => {
    const auth = await import("./auth");
    const step = await auth.login("a@x.org", "right");
    await expect(step!.finish("999999")).rejects.toBeInstanceOf(auth.CodeExpired);
    expect(kek.last!.every((b) => b === 0)).toBe(true);
    await expect(step!.finish("123456")).rejects.toBeInstanceOf(auth.CodeExpired);
  });

  it("starting over forgets the key; a recovery code works like a code", async () => {
    const auth = await import("./auth");
    const step = await auth.login("a@x.org", "right");
    step!.cancel();
    expect(kek.last!.every((b) => b === 0)).toBe(true);
    const again = await auth.login("a@x.org", "right");
    await again!.finish("abcd-efgh-jkmn-pqrs");
    const { mem } = await import("./state");
    expect(mem.me?.user.id).toBe("u");
  });

  it("a wrong password is an error, not a code step", async () => {
    const auth = await import("./auth");
    await expect(auth.login("a@x.org", "wrong")).rejects.toThrow(/Wrong e-mail/);
    expect(kek.last!.every((b) => b === 0)).toBe(true);
  });

  it("reads the server's answers", async () => {
    const { ApiError } = await import("./api");
    const auth = await import("./auth");
    expect(auth.pendingToken(new ApiError(401, "x", { code: "two_factor_required", pending: "p" }))).toBe("p");
    expect(auth.pendingToken(new ApiError(401, "x", { code: "two_factor_required" }))).toBe("");
    expect(auth.pendingToken(new ApiError(403, "x", { code: "two_factor_required", pending: "p" }))).toBe("");
    expect(auth.pendingToken(new Error("x"))).toBe("");
    expect(auth.codeProblem(new ApiError(401, "x", { code: "wrong_code" }))).toBe("wrong");
    expect(auth.codeProblem(new ApiError(401, "x", { code: "two_factor_expired" }))).toBe("expired");
    expect(auth.codeProblem(new ApiError(429, "x", null))).toBe("other");
  });
});
