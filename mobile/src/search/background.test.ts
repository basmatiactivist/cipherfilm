import { beforeEach, describe, expect, it, vi } from "vitest";

// Background indexing sends to the server its settings were made for, never moves the app's own server or token,
// and does nothing for a server the app no longer uses. The server and native modules are stand-ins.
const st = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, local: {} as unknown, saved: "", sent: [] as string[], models: [] as string[][] }));
vi.mock("react-native", () => ({ Platform: { constants: { Model: "Test" } }, AppState: { currentState: "active" } }));
vi.mock("../session", () => ({ savedServer: async () => st.saved }));
vi.mock("./settings", () => ({ loadSettings: async () => st.settings, saveSettings: async () => st.settings }));
vi.mock("./models", () => ({ haveModels: async () => true, modelPath: () => "/models", STANDARD: "mobileclip-s2", keepsStandard: (c: string) => c !== "mobileclip-s2" }));
vi.mock("./engine", () => ({
  localFile: () => ({ exists: true, text: async () => JSON.stringify(st.local), write: async (v: string) => { st.local = JSON.parse(v); } }),
  analyzeBytes: async (_b: Uint8Array, _f: boolean, models: string[]) => { st.models.push(models); return models.map((m) => ({ m })); },
}));
vi.mock("@crypto/search", () => ({ sealIndexEntry: () => new Uint8Array(8) }));
vi.mock("../../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    backupState: () => ({ media: "all", online: true, charging: true }),
    phoneMedia: async () => [{ name: "IMG_1.jpg", size: 10, uri: "content://m/1", mime: "image/jpeg" }],
    visionOpen: async () => {}, visionClose: () => {},
    jpeg: async () => ({ bytes: new Uint8Array(4), width: 1, height: 1 }),
    visionAnalyze: async () => ({}),
  },
}));
vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(url);
    st.sent.push(`${init.method ?? "GET"} ${u.origin}${u.pathname.replace(/[0-9a-f]{32}/, ":id")} ${init.headers?.["X-CSRF-Token"] ?? ""}`.trim());
    if (u.pathname === "/api/me") return new Response(JSON.stringify({ user: { id: "alice" }, csrf: "csrf-bg" }), { status: 200 });
    return new Response("{}", { status: 200 });
  },
}));

const ID = "ab".repeat(16);

describe("background indexing", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { getSodium, b64 } = await import("@crypto/sodium");
    const { fingerprint } = await import("../prints");
    const s = await getSodium();
    st.settings = { enabled: true, background: true, chargingOnly: false, faces: false, server: "https://a.test", userId: "alice", pubkey: b64(s, s.crypto_box_keypair().publicKey) };
    st.local = { userId: "alice", prints: { [await fingerprint("IMG_1.jpg", 10)]: ID }, done: [] };
    st.sent = []; st.models = [];
  });

  it("uses its own server and token and leaves the app's as they are", async () => {
    st.saved = "https://a.test";
    const api = await import("../api");
    api.setServer("https://app.test");
    api.setCsrf("csrf-app");
    const { runBackgroundIndex } = await import("./background");
    expect(await runBackgroundIndex()).toBe(1);
    expect(st.sent).toEqual(["GET https://a.test/api/me", "PUT https://a.test/api/items/:id/index csrf-bg"]);
    expect(api.server()).toBe("https://app.test");
    expect(api.csrfToken()).toBe("csrf-app");
  });

  it("skips an item a run died on instead of trying it at every run", async () => {
    st.saved = "https://a.test";
    st.local = { ...(st.local as object), attempt: ID };
    const { runBackgroundIndex } = await import("./background");
    expect(await runBackgroundIndex()).toBe(0);
    expect(st.sent.filter((r) => r.startsWith("PUT"))).toEqual([]);
    expect(st.local).toMatchObject({ done: [ID] });
    expect((st.local as { attempt?: string }).attempt).toBeUndefined();
  });

  it("does nothing for a server the app no longer uses", async () => {
    st.saved = "https://new.test";
    const api = await import("../api");
    api.setServer("https://new.test");
    const { runBackgroundIndex } = await import("./background");
    expect(await runBackgroundIndex()).toBe(0);
    expect(st.sent).toEqual([]);
    expect(api.server()).toBe("https://new.test");
  });

  it("does nothing (and doesn't fail) with a list of the phone's photos it can't read", async () => {
    st.saved = "https://a.test";
    const { runBackgroundIndex } = await import("./background");
    for (const local of [null, { userId: "alice" }, { userId: "alice", prints: null, done: [] }]) {
      st.local = local;
      expect(await runBackgroundIndex()).toBe(0);
    }
    expect(st.sent).toEqual([]);
  });
});

describe("background indexing with explicit search on", () => {
  it("stores MobileCLIP's entry next to LAION's, from one look at the photo", async () => {
    vi.resetModules();
    const { getSodium, b64 } = await import("@crypto/sodium");
    const { fingerprint } = await import("../prints");
    const s = await getSodium();
    st.settings = { enabled: true, background: true, chargingOnly: false, faces: true, clip: "laion-b32", server: "https://a.test", userId: "alice", pubkey: b64(s, s.crypto_box_keypair().publicKey) };
    st.local = { userId: "alice", prints: { [await fingerprint("IMG_1.jpg", 10)]: ID }, done: [] };
    st.sent = []; st.models = []; st.saved = "https://a.test";
    const { runBackgroundIndex } = await import("./background");
    expect(await runBackgroundIndex()).toBe(1);
    expect(st.models).toEqual([["laion-b32", "mobileclip-s2"]]);
    expect(st.sent.filter((r) => r.startsWith("PUT"))).toHaveLength(2);
  });
});
