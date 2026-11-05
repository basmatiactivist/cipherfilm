import { beforeEach, describe, expect, it, vi } from "vitest";

// The server is a stand-in whose answer to POST /api/items is held back, so the test can change who is signed in
// while the request is out.
const server = vi.hoisted(() => ({
  calls: [] as string[],
  created: null as null | ((id: string) => void),
  asked: null as null | (() => void),
}));
vi.mock("./api", () => ({
  api: async (method: string, path: string) => {
    server.calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/items") return new Promise((r) => { server.created = (id) => r({ id }); server.asked?.(); });
    return {};
  },
  getBytes: async () => new Uint8Array(),
  putBytes: async () => {},
}));
vi.mock("./media", () => ({ kindOf: () => "other", readMeta: async () => ({}), THUMB_PX: 1, PREVIEW_PX: 1 }));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
const keys = () => [...store.keys()];

import { mem } from "./state";
import { discardUpload, isItemId, SignedOut, uploadFile } from "./items";
import { uploadQueue } from "./upqueue";

const signIn = (id: string) => {
  mem.me = { user: { id, email: `${id}@example.com`, role: "user" } } as any;
  mem.masterKey = new Uint8Array(32).fill(id.charCodeAt(0));
};
const file = () => new File([new Uint8Array([1, 2, 3])], "private-name.jpg", { lastModified: 7 });
/** Starts an upload and waits until its POST /api/items is out (wrapped: an async function would wait for the upload). */
const startUpload = async () => {
  const asked = new Promise<void>((r) => { server.asked = r; });
  const run = uploadFile(file(), () => {});
  run.catch(() => {});
  await asked;
  return { run };
};

describe("an upload and the account that started it", () => {
  beforeEach(() => { store.clear(); server.calls = []; signIn("a"); });

  it("writes no resume note when another account signed in while the item was being created", async () => {
    const { run } = await startUpload();
    mem.me = null; mem.masterKey = null; // sign-out...
    signIn("b"); // ...and someone else's sign-in in the same tab
    server.created!("0".repeat(32));
    await expect(run).rejects.toBeInstanceOf(SignedOut);
    expect(keys()).toEqual([]);
    expect(server.calls).toEqual(["POST /api/items"]);
  });

  it("files the resume note under the account that started it", async () => {
    const { run } = await startUpload();
    server.created!("0".repeat(32));
    await run;
    expect(server.calls).toContain(`POST /api/items/${"0".repeat(32)}/finalize`);
    expect(keys()).toEqual([]); // finished: the note is gone again
  });

  it("does not throw away another account's upload", async () => {
    store.set("cf-upload:a:private-name.jpg:3:7", JSON.stringify({ id: "1".repeat(32), wrapped: "x" }));
    signIn("b");
    await discardUpload(file(), "a");
    expect(server.calls).toEqual([]);
    signIn("a");
    await discardUpload(file(), "a");
    expect(server.calls).toEqual([`DELETE /api/items/${"1".repeat(32)}`]);
    expect(keys()).toEqual([]);
  });
});

describe("item ids from the server", () => {
  beforeEach(() => { store.clear(); server.calls = []; signIn("a"); });

  it("accepts only 32 lowercase hex characters", () => {
    expect(isItemId("0123456789abcdef0123456789abcdef")).toBe(true);
    for (const bad of ["0123456789ABCDEF0123456789ABCDEF", "0".repeat(31), "0".repeat(33), "../items", "", 42, null]) expect(isItemId(bad)).toBe(false);
  });

  it("stops the upload before a key is bound to an id that is not one", async () => {
    const { run } = await startUpload();
    server.created!("../../admin");
    await expect(run).rejects.toThrow(/unexpected item id/);
    expect(keys()).toEqual([]);
    expect(server.calls).toEqual(["POST /api/items"]);
  });
});

describe("the upload queue", () => {
  beforeEach(() => signIn("a"));
  const job = (owner = "a") => ({ owner, stop: { cancelled: false } });
  /** A runner whose jobs finish only when released. */
  const gated = () => {
    const ran: object[] = [];
    let release = () => {};
    const run = (j: object) => { ran.push(j); return new Promise<void>((r) => { release = r; }); };
    return { ran, run, release: async () => { release(); await new Promise((r) => setTimeout(r, 0)); } };
  };

  it("starts nothing more once its account signed out, even if another signed in", async () => {
    const g = gated();
    const idle = vi.fn();
    const q = uploadQueue("a", 1, g.run, idle);
    const jobs = [job(), job(), job()];
    q.push(jobs);
    expect(g.ran).toEqual([jobs[0]]);
    signIn("b");
    await g.release();
    expect(g.ran).toEqual([jobs[0]]);
    expect(idle).not.toHaveBeenCalled();
    q.push([job("b")]); // nor does it take files for the new account
    expect(g.ran).toEqual([jobs[0]]);
  });

  it("drops what waits when closed, and refuses another account's files", async () => {
    const g = gated();
    const q = uploadQueue("a", 1, g.run, () => {});
    const jobs = [job(), job()];
    q.push([job("b"), ...jobs]);
    expect(g.ran).toEqual([jobs[0]]);
    q.close();
    await g.release();
    expect(g.ran).toEqual([jobs[0]]);
    q.push([job()]);
    expect(g.ran).toEqual([jobs[0]]);
  });

  it("works off every file while the account stays signed in", async () => {
    const g = gated();
    const idle = vi.fn();
    const q = uploadQueue("a", 1, g.run, idle);
    q.push([job(), job()]);
    await g.release();
    await g.release();
    expect(g.ran.length).toBe(2);
    expect(idle).toHaveBeenCalledOnce();
  });
});
