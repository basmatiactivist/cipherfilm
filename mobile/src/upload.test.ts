import { beforeEach, describe, expect, it, vi } from "vitest";

// The uploader only locks a new item's key to an id of the server's own form, and says what a share would upload where.
const srv = vi.hoisted(() => ({ id: "" as unknown, calls: [] as string[], bodies: new Map<string, any>() }));
vi.mock("./api", () => ({
  api: async (method: string, path: string, body?: unknown) => { srv.calls.push(`${method} ${path}`); srv.bodies.set(`${method} ${path}`, body); return method === "POST" && path === "/api/items" ? { id: srv.id } : {}; },
  putBytes: async (path: string) => { srv.calls.push(`PUT ${path}`); },
}));
const sess = vi.hoisted(() => ({ now: {} as Record<string, unknown> }));
vi.mock("./session", () => ({ session: () => sess.now }));
// what this phone notes as its own uploads (ownUploads.ts)
const own = vi.hoisted(() => [] as [string, string, string][]);
vi.mock("./ownUploads", () => ({ noteOwnUpload: async (u: string, id: string, w: string) => { own.push([u, id, w]); } }));
const notes = vi.hoisted(() => ({ only: true, shown: [] as [string, string, number, boolean][] }));
// the native SHA-256 state stands in as everything fed so far; reading the file gives bytes 0, 1, 2, ... at each offset
const hashing = vi.hoisted(() => ({ on: true, fed: [] as number[] }));
vi.mock("./keepAlive", () => ({ keepRunning: () => false, letGo: () => {}, onlyHolder: () => notes.only }));
vi.mock("../modules/cf-native/src/CfNativeModule", async () => {
  const { Sha256 } = await import("@crypto/sha256");
  return { default: {
    jpeg: async () => null, mediaInfo: async () => ({}), readRange: async (_u: string, o: number, n: number) => Uint8Array.from({ length: n }, (_, k) => (o + k) & 255),
    get sha256_init() { return hashing.on ? () => new Uint8Array(0) : undefined; },
    sha256_update: (st: Uint8Array, m: Uint8Array) => { hashing.fed.push(m.length); const out = new Uint8Array(st.length + m.length); out.set(st); out.set(m, st.length); return out; },
    sha256_final: (st: Uint8Array) => new Sha256().update(st).digest(),
    backupNotify: (title: string, text: string, p: number, ongoing: boolean) => { notes.shown.push([title, text, p, ongoing]); },
  } };
});

const { uploadFile, uploadShared, shareSummary, showUploads, uploadsSummary } = await import("./upload");
const { getSodium, unb64 } = await import("@crypto/sodium");
const { decryptMeta } = await import("@crypto/item");
const { Sha256 } = await import("@crypto/sha256");
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

describe("uploadShared", () => {
  it("notes the item as this phone's own, with the wrapped key it sent", async () => {
    const s = await getSodium();
    srv.calls = []; own.length = 0; srv.id = "2d".repeat(16);
    sess.now = { me: { user: { id: "u1" } }, masterKey: new Uint8Array(32) };
    try {
      expect(await uploadShared(file, () => {}, { cancelled: false })).toBe(srv.id);
    } finally { sess.now = {}; }
    const sent = srv.bodies.get(`POST /api/items/${srv.id}/finalize`).wrapped_item_key;
    expect(own).toEqual([["u1", srv.id, sent]]);
    expect(unb64(s, sent).length).toBeGreaterThan(32);
  });
});

describe("the original's SHA-256", () => {
  beforeEach(() => { srv.calls = []; hashing.on = true; hashing.fed = []; srv.id = "1e".repeat(16); });
  const big = { ...file, size: 4 * 1024 * 1024 + 1000 }; // two parts
  const metaOf = async (key: Uint8Array) => {
    const s = await getSodium();
    return decryptMeta<{ sha256?: string }>(s, unb64(s, srv.bodies.get(`POST /api/items/${srv.id}/finalize`).meta_enc), key, srv.id as string);
  };
  let key: Uint8Array;
  const wrap = (k: Uint8Array) => { key = k.slice(); return new Uint8Array(8); };

  it("goes into the metadata, from the parts as they were read", async () => {
    await uploadFile(big, await getSodium(), wrap, () => {}, () => {});
    expect(hashing.fed).toEqual([4 * 1024 * 1024, 1000]);
    const want = new Sha256().update(Uint8Array.from({ length: big.size }, (_, k) => k & 255)).hex(); // checked against Node in web/src/crypto/sha256.test.ts
    expect((await metaOf(key)).sha256).toBe(want);
  });

  it("is left out by a native build without it", async () => {
    hashing.on = false;
    await uploadFile(file, await getSodium(), wrap, () => {}, () => {});
    expect((await metaOf(key))).not.toHaveProperty("sha256");
  });
});

describe("shareSummary", () => {
  it("names how many, how big and which account", () => {
    expect(shareSummary([{ size: 2_000_000 }, { size: 500_000 }], "a@example.test")).toBe("2 files (2.5 MB) to encrypt and upload to a@example.test.");
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
    expect(uploadsSummary(3, 0)).toEqual({ title: "Upload done", text: "3 files uploaded." });
    expect(uploadsSummary(1, 2)).toEqual({ title: "Upload incomplete", text: "1 file uploaded. 2 files didn't upload. Open Cipherfilm to try again." });
  });
});
