// The main thread's side of search by what is in a photo: hands the image vectors from the index (opened in
// people/people.ts) to the worker, asks it for matches, and says which model this account searches with.
import type { Family, Hit } from "./rank";
import { MODEL_CACHE, TEXT_MODELS, familyOf } from "./rank";
import type { Req, Res } from "./content.worker";
import { adoptCached, forgetModels, modelsAgreed, NeedsConsent, unagree } from "./consent";

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (h: any) => void; fail: (e: Error) => void; progress?: (done: number, total: number) => void }>();
/** item id → which model made its vector, to count what can be searched with which model */
const made = new Map<string, Family>();

function send(r: Req) {
  if (typeof Worker === "undefined") return;
  if (!worker) {
    worker = new Worker(new URL("./content.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<Res>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      if (e.data.t === "progress") { w.progress?.(e.data.done, e.data.total); return; }
      waiting.delete(e.data.id);
      e.data.t === "done" ? w.ok(e.data.hits) : e.data.t === "scores" ? w.ok(e.data.scores) : w.fail(new Error(e.data.error));
    };
    worker.onerror = () => { for (const w of waiting.values()) w.fail(new Error("Search stopped working. Reload the page.")); waiting.clear(); };
  }
  worker.postMessage(r);
}

/** Index entries as they are opened: the image vector (float16) and the model tag. Entries without one drop out. */
export function putVectors(entries: { item: string; m?: string; clip?: Uint8Array }[]) {
  if (!entries.length) return;
  for (const e of entries) {
    const f = familyOf(e.m);
    if (f && e.clip) made.set(e.item, f); else made.delete(e.item);
  }
  send({ t: "put", entries });
}

/** How many photos have a vector from this model (the ones search by content can find). */
export const vectorCount = (f: Family) => { let n = 0; for (const v of made.values()) if (v === f) n++; return n; };

/** Whether this item has a vector from this model (duplicates and similar photos compare only those). */
export const hasVector = (id: string, f: Family) => made.get(id) === f;

/** The cosine of the vectors of a[k] and b[k], NaN where one has none (cleanup/duplicates.ts). */
export function scorePairs(family: Family, a: string[], b: string[]): Promise<Float32Array> {
  if (typeof Worker === "undefined") return Promise.resolve(new Float32Array(a.length).fill(NaN));
  const id = nextId++;
  return new Promise((ok, fail) => { waiting.set(id, { ok, fail }); send({ t: "score", id, family, a, b }); });
}

/** Keeps only the active model's text file in the browser's cache: after a switch (or an admin withdrawing explicit
 *  search) the other one, 64 or 254 MB, doesn't stay behind. */
let kept: Family | null = null;
function dropOtherModel(family: Family) {
  if (kept === family || typeof caches === "undefined") return;
  kept = family;
  const others = (Object.keys(TEXT_MODELS) as Family[]).filter((f) => f !== family);
  unagree(others.map((f) => TEXT_MODELS[f]));
  caches.open(MODEL_CACHE).then((c) => Promise.all(others.map((f) => c.delete(`/api/models/${TEXT_MODELS[f].file}`)))).catch(() => {});
}

/** Whether the model may be used: agreed to, or found already downloaded (consent.ts). Never asks anyone else. */
async function agreed(family: Family): Promise<boolean> {
  if (!modelsAgreed(family)) await adoptCached();
  return modelsAgreed(family);
}

/** Photos matching the words, best first, from the photos the given model indexed. Downloads the model the first
 *  time, and only after the person agreed (consent.ts): otherwise it fails with NeedsConsent and nothing is fetched. */
export async function contentSearch(q: string, family: Family, progress?: (done: number, total: number) => void): Promise<Hit[]> {
  if (typeof Worker === "undefined") return [];
  if (!(await agreed(family))) throw new NeedsConsent(family);
  dropOtherModel(family);
  const id = nextId++;
  return new Promise((ok, fail) => { waiting.set(id, { ok, fail, progress }); send({ t: "search", id, q, family, allow: true }); });
}

/** Downloads (or opens) the model right after the yes in Account › Search, so the first search doesn't wait. */
export async function loadModel(family: Family, progress?: (done: number, total: number) => void): Promise<void> {
  if (typeof Worker === "undefined") return;
  if (!(await agreed(family))) throw new NeedsConsent(family);
  dropOtherModel(family);
  const id = nextId++;
  await new Promise((ok, fail) => { waiting.set(id, { ok, fail, progress }); send({ t: "search", id, q: "", family, allow: true }); });
}

/** Turning search off in this browser: the worker stops, the files and the yes go. */
export async function forgetContentModels() {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.fail(new Error("Search stopped."));
  waiting.clear();
  kept = null;
  await forgetModels();
}

/** Drops the vectors and the loaded model (sign-out, lock). forgetExplicit (sign-out) also removes the model files
 *  from the browser's cache, so nothing on this device shows that search, explicit or not, was used. */
export function clearContent(forgetExplicit = false) {
  made.clear();
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.fail(new Error("Search stopped."));
  waiting.clear();
  // sign-out: both text models go (nothing of the account stays), and with them the yes to download them: whoever signs
  // in next is asked again
  if (forgetExplicit) { kept = null; forgetModels().catch(() => {}); }
}
