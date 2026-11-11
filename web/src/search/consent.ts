// The search model comes from Hugging Face (docs/MODELS.md): a third party, which sees this device's IP address. So
// nothing is fetched from there before a yes, like the map (map/consent.ts). The yes is per device (this browser, any
// account), for the exact files (their SHA-256): another model, explicit search's or a new one in a later release,
// asks again. Account › Search turns it off and deletes the files; signing out does too.
import { useEffect, useState } from "preact/hooks";
import { MODEL_CACHE, TEXT_MODELS, TOKENIZER, type Family, type ModelFile } from "./rank";

const KEY = "cf-models-ok";
/** at: when the yes was given; null when the files were found already downloaded (before this question existed) */
interface Agreed { at: number | null; sha: string[] }

const subs = new Set<() => void>();

function read(): Agreed | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && Array.isArray(v.sha) && v.sha.every((s: unknown) => typeof s === "string") ? { at: typeof v.at === "number" ? v.at : null, sha: v.sha } : null;
  } catch { return null; }
}

function write(v: Agreed | null) {
  try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* storage off: asked again */ }
  subs.forEach((f) => f());
}

/** The files this browser needs to search with a model: its text model and the tokenizer. */
export const filesFor = (f: Family): ModelFile[] => [TEXT_MODELS[f], TOKENIZER];
const ALL = [TOKENIZER, ...Object.values(TEXT_MODELS)];
export const bytesOf = (files: ModelFile[]) => files.reduce((n, m) => n + m.size, 0);
export const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Whether the person agreed to download this model's files (or they were already here). */
export function modelsAgreed(f: Family): boolean {
  const a = read();
  return !!a && filesFor(f).every((m) => a.sha.includes(m.sha256));
}

/** The yes: this model's files may be downloaded. */
export function agreeModels(f: Family) {
  const a = read();
  write({ at: Date.now(), sha: [...new Set([...(a?.sha ?? []), ...filesFor(f).map((m) => m.sha256)])] });
}

/** A model's files were deleted (switching between explicit and standard search): downloading them again asks again. */
export function unagree(files: ModelFile[]) {
  const a = read();
  if (!a) return;
  const sha = a.sha.filter((x) => !files.some((m) => m.sha256 === x));
  if (sha.length !== a.sha.length) write(sha.length ? { ...a, sha } : null);
}

/** Files that were downloaded before this question existed count as a yes (they are here; no nagging). Looks only in
 *  this browser's cache, and only once there is no answer yet: no request goes anywhere. */
let adopting: Promise<void> | null = null;
export function adoptCached(): Promise<void> {
  if (read() || typeof caches === "undefined") return Promise.resolve();
  adopting ??= (async () => {
    const c = await caches.open(MODEL_CACHE);
    const found: string[] = [];
    for (const m of ALL) {
      const hit = await c.match(`/api/models/${m.file}`);
      if (!hit) continue;
      const b = await hit.arrayBuffer();
      if (b.byteLength !== m.size) continue;
      const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
      if (h === m.sha256) found.push(m.sha256);
    }
    if (found.length && !read()) write({ at: null, sha: found });
  })().catch(() => {}).finally(() => { adopting = null; });
  return adopting;
}

/** What was agreed to and when, for Account › Search: null when nothing. */
export function downloaded(): { at: number | null; bytes: number } | null {
  const a = read();
  if (!a) return null;
  return { at: a.at, bytes: bytesOf(ALL.filter((m) => a.sha.includes(m.sha256))) };
}

/** Withdraws the yes and deletes the files from this browser (the caller stops the worker: content.ts clearContent). */
export async function forgetModels() {
  write(null);
  if (typeof caches !== "undefined") await caches.delete(MODEL_CACHE).catch(() => false);
}

/** "Not now" in the search box: not asked again until the page is loaded again. */
const later = new Set<Family>();
export const askLater = (f: Family) => { later.add(f); subs.forEach((g) => g()); };
export const askedLater = (f: Family) => later.has(f);

/** Re-renders when the answer changes (here or in another tab). */
export function useModelConsent(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((x) => x + 1);
    subs.add(f);
    const s = (e: StorageEvent) => { if (e.key === KEY || e.key === null) f(); };
    window.addEventListener("storage", s);
    return () => { subs.delete(f); window.removeEventListener("storage", s); };
  }, []);
  return n;
}

export const MODELS_PRIVACY_URL = "https://cipherfilm.app/privacy#models";

/** Thrown by contentSearch when the model isn't here and the person hasn't agreed to download it. */
export class NeedsConsent extends Error {
  constructor(readonly family: Family) { super("The search model isn't downloaded yet."); }
}
