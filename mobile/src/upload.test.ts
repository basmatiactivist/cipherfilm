import { beforeEach, describe, expect, it, vi } from "vitest";

// The uploader only locks a new item's key to an id of the server's own form, and says what a share would upload where.
const srv = vi.hoisted(() => ({ id: "" as unknown, calls: [] as string[] }));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => { srv.calls.push(`${method} ${path}`); return method === "POST" && path === "/api/items" ? { id: srv.id } : {}; },
  putBytes: async (path: string) => { srv.calls.push(`PUT ${path}`); },
}));
vi.mock("./session", () => ({ session: () => ({}) }));
const notes = vi.hoisted(() => ({ only: true, shown: [] as [string, string, number, boolean][] }));
vi.mock("./keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => notes.only }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    jpeg: async () => null, mediaInfo: async () => ({}), readRange: async (_u: string, _o: number, n: number) => new Uint8Array(n),
    backupNotify: (title: string, text: string, p: number, ongoing: boolean) => { notes.shown.push([title, text, p, ongoing]); },
  },
}));

const { uploadFile, shareSummary, showUploads, uploadsSummary } = await import("./upload");
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

describe("the uploads' notification", () => {
  beforeEach(() => { notes.shown = []; notes.only = true; vi.useFakeTimers(); });

  it("is one, updated in place with the file and n of m, at most once a second between files", () => {
    showUploads(1, 3, "a.jpg", 0, true);
    showUploads(1, 3, "a.jpg", 0.1); // too soon: dropped
    vi.advanceTimersByTime(1500);
    showUploads(1, 3, "a.jpg", 0.2);
    showUploads(2, 3, "b.jpg", 0.4, true); // a new file always shows
    expect(notes.shown).toEqual([["Uploading 1 of 3", "a.jpg", 0, true], ["Uploading 1 of 3", "a.jpg", 0.2, true], ["Uploading 2 of 3", "b.jpg", 0.4, true]]);
    vi.useRealTimers();
  });

  it("leaves the notification to the backup while it runs", () => {
    notes.only = false;
    showUploads(1, 2, "a.jpg", 0, true);
    expect(notes.shown).toEqual([]);
    vi.useRealTimers();
  });

  it("ends with one summary", () => {
    vi.useRealTimers();
    expect(uploadsSummary(0, 0)).toBeNull();
    expect(uploadsSummary(3, 0)).toEqual({ title: "Upload done", text: "3 files encrypted and uploaded." });
    expect(uploadsSummary(1, 2)).toEqual({ title: "Upload incomplete", text: "1 file encrypted and uploaded. 2 files didn't upload. Open Cipherfilm to try again." });
  });
});
