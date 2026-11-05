import { beforeEach, describe, expect, it, vi } from "vitest";

// The uploader only locks a new item's key to an id of the server's own form, and says what a share would upload where.
const srv = vi.hoisted(() => ({ id: "" as unknown, calls: [] as string[] }));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => { srv.calls.push(`${method} ${path}`); return method === "POST" && path === "/api/items" ? { id: srv.id } : {}; },
  putBytes: async (path: string) => { srv.calls.push(`PUT ${path}`); },
}));
vi.mock("./session", () => ({ session: () => ({}) }));
vi.mock("./keepAlive", () => ({ keepRunning: () => false, letGo: () => {} }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: { jpeg: async () => null, mediaInfo: async () => ({}), readRange: async (_u: string, _o: number, n: number) => new Uint8Array(n) },
}));

const { uploadFile, shareSummary } = await import("./upload");
const { getSodium } = await import("@crypto/sodium");
const file = { uri: "content://media/external/images/media/1", name: "a.jpg", size: 10, mime: "image/jpeg", deletable: true };

describe("uploadFile", () => {
  beforeEach(() => { srv.calls = []; });

  for (const bad of ["../me", "AB".repeat(16), "ab".repeat(15), "ab".repeat(16) + "/x", "", 42, null]) {
    it(`refuses the item id ${JSON.stringify(bad)} before using it`, async () => {
      srv.id = bad;
      const wrap = vi.fn(() => new Uint8Array(8));
      await expect(uploadFile(file, await getSodium(), wrap, () => {}, () => {})).rejects.toThrow(/invalid item id/);
      expect(wrap).not.toHaveBeenCalled();
      expect(srv.calls).toEqual(["POST /api/items"]);
    });
  }

  it("uploads under a well-formed id", async () => {
    srv.id = "0f".repeat(16);
    const wrap = vi.fn(() => new Uint8Array(8));
    expect(await uploadFile(file, await getSodium(), wrap, () => {}, () => {})).toBe(srv.id);
    expect(wrap).toHaveBeenCalledWith(expect.any(Uint8Array), srv.id);
    expect(srv.calls).toEqual(["POST /api/items", `PUT /api/items/${srv.id}/segments/0`, `POST /api/items/${srv.id}/finalize`]);
  });
});

describe("shareSummary", () => {
  it("names how many, how big and which account", () => {
    expect(shareSummary([{ size: 2_000_000 }, { size: 500_000 }], "a@example.test")).toBe("2 files (2.5 MB) shared from another app, to be encrypted and uploaded to the library of a@example.test.");
    expect(shareSummary([{ size: 3000 }], "b@example.test")).toMatch(/^1 file \(3 KB\).*b@example\.test\.$/);
  });
});
