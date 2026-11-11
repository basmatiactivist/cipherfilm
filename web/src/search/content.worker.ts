// Search by what is in a photo, off the main thread: holds the image vectors the apps stored (decrypted on the main
// thread), downloads the text model once from Hugging Face, where it is published, into the browser's cache (checked
// against its SHA-256 every time it is opened), turns the query into a vector with ONNX Runtime (WebAssembly, one thread) and ranks.
import * as ort from "onnxruntime-web/wasm";
import { allFinite, unhalf } from "../people/faces";
import { Tokenizer } from "./tokenizer";
import { embed } from "./embed";
import { scoreWith } from "../cleanup/duplicates";
import { Family, Hit, MODEL_CACHE, ModelFile, TEXT_MODELS, TOKENIZER, familyOf, normalize, rank } from "./rank";

export type Req =
  | { t: "put"; entries: { item: string; m?: string; clip?: Uint8Array }[] }
  | { t: "remove"; items: string[] }
  | { t: "search"; id: number; q: string; family: Family }
  /** cosine of the vectors of a[k] and b[k] (NaN where one has none): duplicates and similar photos (cleanup/) */
  | { t: "score"; id: number; family: Family; a: string[]; b: string[] };

export type Res =
  | { id: number; t: "progress"; done: number; total: number }
  | { id: number; t: "done"; hits: Hit[] }
  | { id: number; t: "scores"; scores: Float32Array }
  | { id: number; t: "error"; error: string };

ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which the app doesn't have; one is fast enough for text
ort.env.wasm.proxy = false;

const vectors: Record<Family, Map<string, Float32Array>> = { mcs2: new Map(), laionb32: new Map() };

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: ArrayBuffer) => hex(await crypto.subtle.digest("SHA-256", b));

const failed = "Couldn't download the search model from Hugging Face. Try again.";
const wrong = "The downloaded search model isn't the expected file.";

/** A model file: from the cache if it is there and still has the right hash, else from its pinned Hugging Face URL
 *  (then cached). Nothing of the account goes along: no cookie, no referrer. A dropped connection continues with
 *  Range where it stopped, as long as each try gets somewhere. */
async function file(m: ModelFile, progress: (done: number) => void): Promise<ArrayBuffer> {
  const { size, sha256 } = m;
  const key = `/api/models/${m.file}`;
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const hit = await cache?.match(key);
  if (hit) {
    const b = await hit.arrayBuffer();
    if (b.byteLength === size && (await sha(b)) === sha256) { progress(size); return b; }
    await cache!.delete(key);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (let fruitless = 0; at < size; ) {
    const before = at;
    try {
      const res = await fetch(m.url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: at ? { Range: `bytes=${at}-` } : {} });
      if (res.status === 404 || res.status === 403) throw new Error(failed, { cause: "final" });
      if (!res.ok || !res.body) throw new Error(failed);
      if (res.status === 200) at = 0; // the whole file after all: from the start
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > size) throw new Error(wrong, { cause: "final" });
        out.set(value, at);
        at += value.length;
        progress(at);
      }
      if (at < size) throw new Error(failed);
    } catch (e) {
      if (e instanceof Error && e.cause === "final") throw e;
      fruitless = at > before ? 0 : fruitless + 1;
      if (fruitless >= 4) throw new Error(failed);
      await new Promise((ok) => setTimeout(ok, 1000 << fruitless)); // 2, 4, 8 s
    }
  }
  if ((await sha(out.buffer)) !== sha256) throw new Error(wrong);
  await cache?.put(key, new Response(out.buffer, { headers: { "Content-Type": "application/octet-stream" } })).catch(() => {}); // full storage: works, just downloads again next time
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
  tokenizer ??= file(TOKENIZER, (d) => { tok = d; tell(); })
    .then((b) => new Tokenizer(JSON.parse(new TextDecoder().decode(b))))
    .catch((e) => { tokenizer = null; throw e; });
  const s = (async () => {
    await tokenizer;
    tok = TOKENIZER.size;
    const bytes = await file(m, (d) => { mod = d; tell(); });
    (await prev?.session.catch(() => null))?.release();
    return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  })();
  loaded = { family, session: s };
  s.catch(() => { if (loaded?.session === s) loaded = null; });
  return s;
}

function remove(item: string) { vectors.mcs2.delete(item); vectors.laionb32.delete(item); }

self.onmessage = async (e: MessageEvent<Req>) => {
  // a dedicated worker only hears from the page that created it (origin empty); refuse anything else
  if (e.origin && e.origin !== self.location.origin) return;
  const r = e.data;
  if (r?.t === "put" && Array.isArray(r.entries)) {
    for (const x of r.entries) {
      remove(x.item);
      const f = familyOf(x.m);
      const v = f && x.clip && x.clip.length >= 1024 ? unhalf(x.clip) : null;
      if (f && v && allFinite(v)) vectors[f].set(x.item, normalize(v));
    }
  } else if (r?.t === "remove" && Array.isArray(r.items)) r.items.forEach(remove);
  else if (r?.t === "score" && Object.hasOwn(TEXT_MODELS, r.family) && Array.isArray(r.a) && Array.isArray(r.b) && r.a.length === r.b.length) {
    const v = vectors[r.family];
    const scores = scoreWith((id) => v.get(id))(r.a, r.b);
    self.postMessage({ id: r.id, t: "scores", scores } satisfies Res, { transfer: [scores.buffer] });
  } else if (r?.t === "search" && typeof r.q === "string" && Object.hasOwn(TEXT_MODELS, r.family)) {
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
