import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { b64, getSodium, type Sodium } from "./crypto/sodium";
import { newItemKey } from "./crypto/item";
import { encryptSegment } from "./crypto/file";

// The Service Worker's keys and download jobs belong to the tab that handed them over: another tab of the same
// browser (one still at the Unlock screen) gets nothing from them, and they don't outlive that tab. The worker runs
// here against stand-ins for its global scope, the tabs and the server; crypto is real.
const ORIGIN = "https://photos.example.test";
const id = "0123456789abcdef0123456789abcdef";
const plain = new TextEncoder().encode("the original, decrypted");

let s: Sodium;
let itemKey: Uint8Array;
let segment: Uint8Array;
beforeAll(async () => {
  s = await getSodium();
  itemKey = newItemKey(s);
  segment = encryptSegment(s, itemKey, id, 0, 1, plain.length, plain);
});

interface Tab { id: string; key?: object | null; asked: number; postMessage(m: any, ports?: MessagePort[]): void }
let tabs: Tab[];
const handlers: Record<string, (e: any) => void> = {};

function tab(tabId: string, holds: boolean): Tab {
  const t: Tab = {
    id: tabId, asked: 0, key: holds ? { key: b64(s, itemKey), size: plain.length, count: 1, mime: "video/mp4" } : null,
    postMessage(m, ports) { if (m.type === "need-key") { t.asked++; ports![0].postMessage(t.key ?? null); } },
  };
  tabs.push(t);
  return t;
}

beforeEach(async () => {
  vi.resetModules();
  tabs = [];
  for (const k of Object.keys(handlers)) delete handlers[k];
  (globalThis as any).self = {
    addEventListener: (type: string, f: (e: any) => void) => { handlers[type] = f; },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      get: async (cid: string) => tabs.find((t) => t.id === cid),
      matchAll: async () => [...tabs],
    },
  };
  (globalThis as any).location = { origin: ORIGIN };
  vi.stubGlobal("fetch", async (u: string) =>
    u === `/api/items/${id}/segments/0` ? new Response(segment.slice()) : new Response("", { status: 404 }));
  await import("./sw");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function get(path: string, init: { clientId?: string; mode?: string; destination?: string } = {}): Promise<Response> {
  let res: Promise<Response> | undefined;
  handlers.fetch({
    request: { url: ORIGIN + path, mode: init.mode ?? "no-cors", destination: init.destination ?? "video", headers: new Headers() },
    clientId: init.clientId ?? "",
    respondWith: (p: Promise<Response>) => { res = p; },
  });
  if (!res) throw new Error("not handled");
  return res;
}

function job(from: Tab | undefined, token: string, entry: object = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => { ch.port1.close(); resolve(false); }, 50);
    ch.port1.onmessage = () => { clearTimeout(t); ch.port1.close(); resolve(true); };
    handlers.message({
      origin: ORIGIN, source: from, ports: [ch.port2],
      data: { type: "job", token, job: { kind: "file", name: "a.mov", entries: [{ id, key: b64(s, itemKey), size: plain.length, count: 1, mime: "", name: "a.mov", mtime: 1, ...entry }] } },
    });
  });
}
const text = async (r: Response) => new TextDecoder().decode(await r.arrayBuffer());

describe("download jobs", () => {
  it("are fetched once, while the tab that made them is open", async () => {
    const a = tab("A", true);
    expect(await job(a, "t1")).toBe(true);
    const r = await get("/sw/dl/t1", { mode: "navigate", destination: "document" });
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("the original, decrypted");
    expect((await get("/sw/dl/t1", { mode: "navigate", destination: "document" })).status).toBe(404);
  });

  it("go with the tab that made them", async () => {
    const a = tab("A", true);
    expect(await job(a, "t2")).toBe(true);
    tabs.splice(tabs.indexOf(a), 1); // closed without locking
    tab("B", false); // a new tab, at the Unlock screen
    expect((await get("/sw/dl/t2", { mode: "navigate", destination: "document" })).status).toBe(404);
  });

  it("expire if not fetched within a minute", async () => {
    const a = tab("A", true);
    expect(await job(a, "t3")).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await get("/sw/dl/t3", { mode: "navigate", destination: "document" })).status).toBe(404);
  });

  it("are taken only from a tab, and only with a segment count that fits the size", async () => {
    const a = tab("A", true);
    expect(await job(undefined, "t4")).toBe(false);
    expect(await job(a, "t5", { count: 0 })).toBe(false);
    expect(await job(a, "t6", { count: 2 })).toBe(false);
    expect((await get("/sw/dl/t5", { mode: "navigate", destination: "document" })).status).toBe(404);
  });

  it("go on lock and sign-out", async () => {
    const a = tab("A", true);
    expect(await job(a, "t7")).toBe(true);
    handlers.message({ origin: ORIGIN, data: { type: "clear" }, ports: [] });
    expect((await get("/sw/dl/t7", { mode: "navigate", destination: "document" })).status).toBe(404);
  });
});

describe("streams", () => {
  it("play for the tab that holds the key", async () => {
    const a = tab("A", true);
    const r = await get(`/sw/stream/${id}`, { clientId: "A" });
    expect(r.status).toBe(200);
    expect(await text(r)).toBe("the original, decrypted");
    expect(a.asked).toBe(1);
  });

  it("give another tab nothing, even while the key is held for the first one", async () => {
    tab("A", true);
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(200);
    const b = tab("B", false);
    expect((await get(`/sw/stream/${id}`, { clientId: "B" })).status).toBe(404);
    expect(b.asked).toBe(1); // asked itself, and it has no key
  });

  it("ask only the tab that is playing, and nothing without one", async () => {
    const a = tab("A", true);
    expect((await get(`/sw/stream/${id}`)).status).toBe(404);
    expect(a.asked).toBe(0);
  });

  it("forget a tab's key when the tab is gone, and ask again after a few idle minutes", async () => {
    const a = tab("A", true);
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(200);
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(200);
    expect(a.asked).toBe(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(200);
    expect(a.asked).toBe(2);
    // the tab is closed; the next request from another tab drops what it held (were the same id ever seen again,
    // nothing would be left for it)
    tabs.splice(tabs.indexOf(a), 1);
    tab("C", false);
    expect((await get(`/sw/stream/${id}`, { clientId: "C" })).status).toBe(404);
    const back = tab("A", false);
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(404);
    expect(back.asked).toBe(1);
  });

  it("refuse a key whose segment count doesn't fit the size", async () => {
    const a = tab("A", true);
    a.key = { ...(a.key as object), count: 0 };
    expect((await get(`/sw/stream/${id}`, { clientId: "A" })).status).toBe(404);
  });

  it("are never a page", async () => {
    tab("A", true);
    expect((await get(`/sw/stream/${id}`, { clientId: "A", mode: "navigate", destination: "document" })).status).toBe(404);
  });
});
