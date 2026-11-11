import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Decrypted copies for leaving the app must not stay on the phone: removed right after a save (also when it fails),
// cut-short copies never kept, everything gone at a lock, and a native clean-up scheduled for when the app isn't
// running. The phone's storage, the server and the native module are stand-ins.
const disk = vi.hoisted(() => new Map<string, number>()); // path -> bytes written
vi.mock("expo-file-system", () => {
  const pathOf = (p: unknown) => (typeof p === "string" ? p : (p as { uri: string }).uri);
  class Directory {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(pathOf).join("/"); }
    get exists() { return [...disk.keys()].some((k) => k === this.uri || k.startsWith(this.uri + "/")); }
    create() { disk.set(this.uri, -1); }
    delete() { for (const k of [...disk.keys()]) if (k === this.uri || k.startsWith(this.uri + "/")) disk.delete(k); }
  }
  class File {
    uri: string;
    constructor(...p: unknown[]) { this.uri = p.map(pathOf).join("/"); }
    get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
    get size() { return disk.get(this.uri) ?? 0; }
    create() { disk.set(this.uri, 0); }
    open() { return { writeBytesSync: (b: Uint8Array) => { disk.set(this.uri, (disk.get(this.uri) ?? 0) + b.length); }, close: () => {} }; }
    delete() { disk.delete(this.uri); }
  }
  return { Directory, File, Paths: { cache: "/cache" } };
});
const native = vi.hoisted(() => ({ saved: [] as string[], failSave: false, sweeps: 0, revoked: 0, shared: [] as string[] }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    saveToLibrary: async (path: string) => { if (native.failSave) throw new Error("full"); native.saved.push(path); return "content://media/1"; },
    shareFiles: async (paths: string[]) => { native.shared = paths; return true; },
    revokeShared: () => { native.revoked++; },
    outboxSweepLater: () => { native.sweeps++; },
  },
}));
const server = vi.hoisted(() => ({ failAt: -1 }));
vi.mock("./api", () => ({ getBytes: async (p: string) => { if (p.endsWith(`/${server.failAt}`)) throw new Error("offline"); return new Uint8Array(4); } }));
vi.mock("@crypto/sodium", () => ({ getSodium: async () => ({ to_hex: () => "ab", randombytes_buf: () => new Uint8Array(16) }) }));
vi.mock("@crypto/file", () => ({ decryptSegment: () => new Uint8Array(4) }));
const wipes = vi.hoisted(() => [] as ((how: string) => void)[]);
vi.mock("./session", () => ({ onWipe: (f: (how: string) => void) => { wipes.push(f); }, session: () => ({ masterKey: new Uint8Array(32) }) }));
vi.mock("./autolock", () => ({ away: (f: () => Promise<unknown>) => f() }));
// an edited photo leaves as the edited copy (edit.ts, a stand-in here): written like the others, as a JPEG
vi.mock("./edit", () => ({
  editedCopyTo: async (dir: { uri: string }, it: { meta: { name: string } }) => {
    const path = `${dir.uri}/${it.meta.name.replace(/\.\w+$/, "")} (edited).jpg`;
    disk.set(path, 10);
    return { uri: path, name: path.slice(path.lastIndexOf("/") + 1), delete: () => disk.delete(path) };
  },
}));

const item = (id: string, segments = 2) => ({ id, size: 4 * segments, segment_count: segments, kind: "image", itemKey: new Uint8Array(32), meta: { name: `${id}.jpg`, mime: "image/jpeg" } }) as never;
const plaintext = () => [...disk.entries()].filter(([, n]) => n >= 0).map(([k]) => k);

beforeEach(() => {
  vi.resetModules();
  disk.clear(); wipes.length = 0; server.failAt = -1;
  Object.assign(native, { saved: [], failSave: false, sweeps: 0, revoked: 0, shared: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe("save to phone", () => {
  it("removes each decrypted copy right after it is in the photo library", async () => {
    const { saveItems } = await import("./outbox");
    await saveItems([item("a"), item("b")], () => {});
    expect(native.saved).toEqual(["/cache/cf-out/save/a.jpg", "/cache/cf-out/save/b.jpg"]);
    expect(plaintext()).toEqual([]);
    expect(disk.size).toBe(0); // the folder too
    expect(native.sweeps).toBe(1);
  });

  it("removes the copy when saving fails", async () => {
    const { saveItems } = await import("./outbox");
    native.failSave = true;
    await expect(saveItems([item("a")], () => {})).rejects.toThrow("full");
    expect(disk.size).toBe(0);
  });

  it("never keeps a copy cut short by a failed download", async () => {
    const { saveItems } = await import("./outbox");
    server.failAt = 1; // the second part
    await expect(saveItems([item("a")], () => {})).rejects.toThrow("offline");
    expect(native.saved).toEqual([]);
    expect(disk.size).toBe(0);
  });
});

describe("edited photos", () => {
  const edited = (id: string) => ({ ...(item(id) as object), meta: { name: `${id}.heic`, mime: "image/heic", edit: { rot: 90, v: "x" } } }) as never;
  it("leave the app as edited, unless the original is asked for", async () => {
    const { saveItems, prepareShare } = await import("./outbox");
    await saveItems([edited("a"), item("b")], () => {});
    expect(native.saved).toEqual(["/cache/cf-out/save/a (edited).jpg", "/cache/cf-out/save/b.jpg"]);
    native.saved = [];
    await saveItems([edited("a")], () => {}, { original: true });
    expect(native.saved).toEqual(["/cache/cf-out/save/a.heic"]);
    expect(disk.size).toBe(0);
    const ready = await prepareShare([edited("c")], () => {});
    await ready.send();
    expect(native.shared[0]).toMatch(/c \(edited\)\.jpg$/);
  });
});

describe("share", () => {
  it("keeps the copies for the receiving app, then a lock removes them and takes the access back", async () => {
    const { prepareShare } = await import("./outbox");
    const { send } = await prepareShare([item("a"), item("b", 1)], () => {});
    await send();
    expect(native.shared).toEqual(["/cache/cf-out/ab/a.jpg", "/cache/cf-out/ab/b.jpg"]);
    expect(plaintext()).toHaveLength(2);
    expect(native.sweeps).toBe(1); // removed natively too, if the app is ended before it comes back
    wipes.forEach((f) => f("locked"));
    expect(disk.size).toBe(0);
    expect(native.revoked).toBeGreaterThan(0);
  });

  it("a new share first removes the last one's copies", async () => {
    const { prepareShare } = await import("./outbox");
    await prepareShare([item("a")], () => {});
    await prepareShare([item("b")], () => {});
    expect(plaintext()).toEqual(["/cache/cf-out/ab/b.jpg"]);
  });

  it("coming back after a while removes them; right after the share they stay", async () => {
    vi.useFakeTimers();
    const { prepareShare, tidyOutbox } = await import("./outbox");
    const { send } = await prepareShare([item("a")], () => {});
    await send();
    vi.advanceTimersByTime(60_000);
    tidyOutbox();
    expect(plaintext()).toHaveLength(1);
    vi.advanceTimersByTime(15 * 60_000);
    tidyOutbox();
    expect(disk.size).toBe(0);
  });

  it("a share that was prepared but never sent goes at the next return to the app", async () => {
    const { prepareShare, tidyOutbox } = await import("./outbox");
    await prepareShare([item("a")], () => {});
    tidyOutbox();
    expect(disk.size).toBe(0);
  });
});
