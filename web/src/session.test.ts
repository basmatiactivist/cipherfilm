import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What /api/me answers: the account and session the cookie belongs to now, or a 401.
const server = vi.hoisted(() => ({ me: null as null | { user: { id: string }; session_id?: string }, status: 200 }));

vi.mock("./api", () => {
  class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
  return {
    ApiError,
    setCsrf: () => {},
    dropRequests: () => {},
    api: async (_method: string, path: string) => {
      if (path !== "/api/me") throw new Error(`unexpected ${path}`);
      if (server.status !== 200) throw new ApiError(server.status, "unauthorized");
      return { csrf: "c", wrapped_privkey: "x", ...server.me, user: { email: "x@x.org", role: "user", ...server.me!.user } };
    },
  };
});
vi.mock("./cache", () => ({ clearCaches: () => {} }));
vi.mock("./player", () => ({ clearPlayer: () => {} }));
vi.mock("./items", () => ({ clearUploadMemory: () => {}, forgetDecrypted: () => {} }));
vi.mock("./keep", () => ({ keptKey: async () => null, keepKey: async () => {}, forgetKeptForGood: async () => {} }));

describe("checking the session before a reconnect, and when /api/me loads again", () => {
  let events: string[];
  beforeEach(async () => {
    vi.resetModules();
    events = [];
    const w = new EventTarget();
    for (const t of ["cf-session-ended", "cf-session-replaced"]) w.addEventListener(t, () => events.push(t));
    vi.stubGlobal("window", w);
    server.status = 200;
    const { mem } = await import("./state");
    mem.me = { user: { id: "a" }, session_id: "s1" } as any;
    mem.masterKey = new Uint8Array([1]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("goes on for the same account and session", async () => {
    server.me = { user: { id: "a" }, session_id: "s1" };
    await (await import("./auth")).checkSession();
    expect(events).toEqual([]);
  });

  it("ends the tab when another account holds the cookie now", async () => {
    server.me = { user: { id: "b" }, session_id: "s2" };
    await expect((await import("./auth")).checkSession()).rejects.toThrow();
    expect(events).toEqual(["cf-session-replaced"]);
  });

  it("ends the tab when the same account signed in again (a new session)", async () => {
    server.me = { user: { id: "a" }, session_id: "s2" };
    await expect((await import("./auth")).checkSession()).rejects.toThrow();
    expect(events).toEqual(["cf-session-replaced"]);
  });

  it("ends the tab on a 401, which api.ts leaves to the caller for /api/me", async () => {
    server.status = 401;
    await expect((await import("./auth")).checkSession()).rejects.toThrow();
    expect(events).toEqual(["cf-session-ended"]);
  });

  it("a server that is away is only a failed try", async () => {
    server.status = 0;
    await expect((await import("./auth")).checkSession()).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("loadSession doesn't take over another account's session", async () => {
    server.me = { user: { id: "b" }, session_id: "s2" };
    const { loadSession } = await import("./auth");
    expect(await loadSession()).toBeNull();
    expect(events).toEqual(["cf-session-replaced"]);
  });
});
