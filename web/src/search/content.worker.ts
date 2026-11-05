// Search by what is in a photo, off the main thread: holds the image vectors the apps stored (decrypted on the main
// thread), downloads the text model once from this server into the browser's cache (checked against its SHA-256 every
// time it is opened), turns the query into a vector with ONNX Runtime (WebAssembly, one thread) and ranks.
import * as ort from "onnxruntime-web/wasm";
import { allFinite, unhalf } from "../people/faces";
import { Tokenizer } from "./tokenizer";
import { embed } from "./embed";
import { Family, Hit, MODEL_CACHE, TEXT_MODELS, TOKENIZER, familyOf, normalize, rank } from "./rank";

export type Req =
  | { t: "put"; entries: { item: string; m?: string; clip?: Uint8Array }[] }
  | { t: "remove"; items: string[] }
  | { t: "search"; id: number; q: string; family: Family };

export type Res =
  | { id: number; t: "progress"; done: number; total: number }
  | { id: number; t: "done"; hits: Hit[] }
  | { id: number; t: "error"; error: string };

ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the app doesn't have; one is fast enough for text
ort.env.wasm.proxy = false;

const vectors: Record<Family, Map<string, Float32Array>> = { mcs2: new Map(), laionb32: new Map() };

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: ArrayBuffer) => hex(await crypto.subtle.digest("SHA-256", b));

/** A model file: from the cache if it is there and still has the right hash, else from the server (then cached). */
async function file(name: string, sha256: string, size: number, progress: (done: number) => void): Promise<ArrayBuffer> {
  const url = `/api/models/${name}`;
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) {
    const b = await hit.arrayBuffer();
    if (b.byteLength === size && (await sha(b)) === sha256) { progress(size); return b; }
    await cache!.delete(url);
  }
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 404) throw new Error(name.startsWith("nsfw-") ? "Explicit search isn't allowed for this account." : "This server doesn't have the search model.");
  if (!res.ok || !res.body) throw new Error("Couldn't download the search model. Try again.");
  const out = new Uint8Array(size);
  let at = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > size) throw new Error("The search model from the server isn't the expected file.");
    out.set(value, at);
    at += value.length;
    progress(at);
  }
  if (at !== size || (await sha(out.buffer)) !== sha256) throw new Error("The search model from the server isn't the expected file.");
  await cache?.put(url, new Response(out.buffer, { headers: { "Content-Type": "application/octet-stream" } })).catch(() => {}); // full storage: works, just downloads again next time
  return out.buffer;
}

let tokenizer: Promise<Tokenizer> | null = null;
let loaded: { family: Family; session: Promise<ort.InferenceSession> } | null = null;

async function session(family: Family, progress: (done: number, total: number) => void): Promise<ort.InferenceSession> {
  if (loaded?.family === family) return loaded.session;
  const prev = loaded;
  const m = TEXT_MODELS[family];
  const total = m.size + TOKENIZER.size;
  let tok = 0, mod = 0;
  const tell = () => progress(tok + mod, total);
  tokenizer ??= file(TOKENIZER.file, TOKENIZER.sha256, TOKENIZER.size, (d) => { tok = d; tell(); })
    .then((b) => new Tokenizer(JSON.parse(new TextDecoder().decode(b))))
    .catch((e) => { tokenizer = null; throw e; });
  const s = (async () => {
    await tokenizer;
    tok = TOKENIZER.size;
    const bytes = await file(m.file, m.sha256, m.size, (d) => { mod = d; tell(); });
    (await prev?.session.catch(() => null))?.release();
    return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  })();
  loaded = { family, session: s };
  s.catch(() => { if (loaded?.session === s) loaded = null; });
  return s;
}

function remove(item: string) { vectors.mcs2.delete(item); vectors.laionb32.delete(item); }

self.onmessage = async (e: MessageEvent<Req>) => {
  const r = e.data;
  if (r.t === "put") {
    for (const x of r.entries) {
      remove(x.item);
      const f = familyOf(x.m);
      const v = f && x.clip && x.clip.length >= 1024 ? unhalf(x.clip) : null;
      if (f && v && allFinite(v)) vectors[f].set(x.item, normalize(v));
    }
  } else if (r.t === "remove") r.items.forEach(remove);
  else {
    const post = (m: Res) => self.postMessage(m);
    try {
      const s = await session(r.family, (done, total) => post({ id: r.id, t: "progress", done, total }));
      const v = await embed(s, await tokenizer!, r.q, TEXT_MODELS[r.family].int32);
      post({ id: r.id, t: "done", hits: rank(v, vectors[r.family]) });
    } catch (err) {
      post({ id: r.id, t: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
};
