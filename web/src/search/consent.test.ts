// @ts-nocheck: runs in Node (vitest) with stand-ins for the browser's storage, cache and worker
// Nothing is fetched from Hugging Face before the person agreed (docs/MODELS.md): the gate in content.ts and, behind
// it, in the worker; the yes is kept, files already here count as one, and turning off deletes them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_MODELS, TOKENIZER, MODEL_CACHE } from "./rank";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
const cached = new Map<string, Map<string, Response>>();
globalThis.caches = {
  open: async (n) => { if (!cached.has(n)) cached.set(n, new Map()); const c = cached.get(n); return { match: async (k) => c.get(k)?.clone(), put: async (k, r) => void c.set(k, r), delete: async (k) => c.delete(k) }; },
  delete: async (n) => cached.delete(n),
};
const posted: any[] = [];
let lastWorker: any = null;
globalThis.Worker = class { onmessage = null; onerror = null; constructor() { lastWorker = this; } postMessage(r) { posted.push(r); if (r.t === "search") queueMicrotask(() => this.onmessage?.({ data: { id: r.id, t: "done", hits: [] } })); } terminate() {} };
const fetches: string[] = [];
globalThis.fetch = vi.fn(async (u) => { fetches.push(String(u)); return new Response(null, { status: 404 }); });

const consent = await import("./consent");
const content = await import("./content");

beforeEach(() => { store.clear(); cached.clear(); posted.length = 0; fetches.length = 0; });

describe("asking before the search model is downloaded (web)", () => {
  it("without a yes, search asks the worker for nothing and fetches nothing", async () => {
    await expect(content.contentSearch("dog", "laionb32", true)).rejects.toBeInstanceOf(consent.NeedsConsent);
    await expect(content.loadModel("laionb32")).rejects.toBeInstanceOf(consent.NeedsConsent);
    expect(posted.filter((r) => r.t === "search")).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it("the yes is kept (per device), covers exactly that model's files, and lets search run", async () => {
    expect(consent.modelsAgreed("laionb32")).toBe(false);
    consent.agreeModels("laionb32");
    expect(consent.modelsAgreed("laionb32")).toBe(true);
    expect(JSON.parse(store.get("cf-models-ok")).sha).toEqual([TEXT_MODELS.laionb32.sha256, TOKENIZER.sha256]);
    await content.contentSearch("dog", "laionb32", true);
    expect(posted.find((r) => r.t === "search")).toMatchObject({ q: "dog", family: "laionb32", allow: true, filtered: true });
    expect(consent.downloaded()).toMatchObject({ bytes: TEXT_MODELS.laionb32.size + TOKENIZER.size });
    expect(consent.downloaded().at).toBeGreaterThan(0);
  });

  it("a yes to the files of the model before (MobileCLIP) doesn't cover the new one", () => {
    // what an earlier version stored after the yes to MobileCLIP's text model and tokenizer
    store.set("cf-models-ok", JSON.stringify({ at: 1, sha: ["f8aaa97cf17fbadd78b0bd6d5f6a1c57f712402cacc3055ea92c1a3331357dfe", "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85"] }));
    expect(consent.modelsAgreed("laionb32")).toBe(false);
    // one who had explicit search's text model (the same file) is asked only for the new tokenizer
    store.set("cf-models-ok", JSON.stringify({ at: 1, sha: [TEXT_MODELS.laionb32.sha256] }));
    expect(consent.modelsAgreed("laionb32")).toBe(false);
  });

  it("a model update (another SHA-256) asks again", () => {
    store.set("cf-models-ok", JSON.stringify({ at: 1, sha: ["0".repeat(64), TOKENIZER.sha256] }));
    expect(consent.modelsAgreed("laionb32")).toBe(false);
  });

  it("files downloaded before the question existed count as a yes, without a date", async () => {
    const c = await caches.open(MODEL_CACHE);
    const fake = new Uint8Array(TOKENIZER.size); // not the real file: its hash differs, so it doesn't count
    await c.put(`/api/models/${TOKENIZER.file}`, new Response(fake));
    await consent.adoptCached();
    expect(consent.modelsAgreed("laionb32")).toBe(false);
    expect(store.has("cf-models-ok")).toBe(false);
    // the real hash: stand in a digest that matches
    const real = vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => Uint8Array.from(TOKENIZER.sha256.match(/../g).map((h) => parseInt(h, 16))).buffer);
    await consent.adoptCached();
    real.mockRestore();
    expect(JSON.parse(store.get("cf-models-ok"))).toEqual({ at: null, sha: [TOKENIZER.sha256] });
    expect(consent.downloaded()).toEqual({ at: null, bytes: TOKENIZER.size });
  });

  it("turning off withdraws the yes and deletes the files", async () => {
    consent.agreeModels("laionb32");
    await caches.open(MODEL_CACHE);
    await content.forgetContentModels();
    expect(consent.modelsAgreed("laionb32")).toBe(false);
    expect(cached.has(MODEL_CACHE)).toBe(false);
    expect(consent.downloaded()).toBeNull();
  });

  it("signing out withdraws it too", () => {
    consent.agreeModels("laionb32");
    content.clearContent(true);
    expect(consent.modelsAgreed("laionb32")).toBe(false);
  });

  it("the files of earlier versions: LAION's text model keeps its bytes under the new name, MobileCLIP's go", async () => {
    const c = await caches.open(MODEL_CACHE);
    await c.put("/api/models/nsfw-laion-b32-text.onnx", new Response("laion"));
    await c.put("/api/models/mobileclip-s2-text.onnx", new Response("mcs2"));
    await c.put("/api/models/mobileclip-s2-tokenizer.json", new Response("tok"));
    consent.agreeModels("laionb32");
    await content.contentSearch("dog", "laionb32", true);
    const keys = [...cached.get(MODEL_CACHE).keys()];
    expect(keys).toEqual([`/api/models/${TEXT_MODELS.laionb32.file}`]);
    expect(await (await c.match(`/api/models/${TEXT_MODELS.laionb32.file}`)).text()).toBe("laion");
    expect(fetches).toEqual([]);
  });
});

describe("the worker without the yes", () => {
  it("uses only a cached file and never fetches", async () => {
    vi.doMock("onnxruntime-web/wasm", () => ({ env: { wasm: {} }, InferenceSession: { create: async () => ({}) }, Tensor: class {} }));
    const out: any[] = [];
    globalThis.self = { location: { origin: "" }, postMessage: (m) => out.push(m), onmessage: null };
    await import("./content.worker");
    await self.onmessage({ origin: "", data: { t: "search", id: 1, q: "dog", family: "laionb32" } });
    expect(fetches).toEqual([]);
    expect(out.at(-1)).toEqual({ id: 1, t: "error", error: "The search model isn't downloaded yet." });
  });
});
