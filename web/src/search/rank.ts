// Search by what is in a photo, as on Android and Mac (docs/SEARCH.md): the apps stored an image vector per photo in
// the encrypted index; the browser turns the words into a vector with the matching text model and ranks by cosine.
// Pure functions here (models, ranking); the model itself runs in content.worker.ts.
import LIST from "../../../server/models.json";

/** Which model made a vector: the start of the index entry's `m` tag. */
export type Family = "mcs2" | "laionb32";

/** A file from the one model list (server/models.json): its name, pinned Hugging Face URL, SHA-256 and size. */
export interface ModelFile { file: string; url: string; sha256: string; size: number }

const pinned = (file: string): ModelFile => {
  const m = LIST.find((x) => x.name === file);
  if (!m) throw new Error(`${file} is not in server/models.json`);
  return { file, url: m.url, sha256: m.sha256, size: m.size };
};

export interface TextModel extends ModelFile {
  family: Family;
  /** LAION's export takes int32 ids, MobileCLIP's int64 */
  int32: boolean;
}

export const TOKENIZER = pinned("mobileclip-s2-tokenizer.json");

export const TEXT_MODELS: Record<Family, TextModel> = {
  mcs2: { family: "mcs2", ...pinned("mobileclip-s2-text.onnx"), int32: false },
  laionb32: { family: "laionb32", ...pinned("nsfw-laion-b32-text.onnx"), int32: true },
};

export const CONTEXT = 77;
/** The browser cache (Cache API) the model files are kept in, under their old /api/models/ URL as the key (files
 *  cached before they came from Hugging Face stay usable). */
export const MODEL_CACHE = "cf-models-1";

/** The model family of an index entry's tag ("mcs2+yunet23+sface21/2", "laionb32/1"), or undefined for others. */
export function familyOf(tag: string | undefined): Family | undefined {
  const f = (tag ?? "").split(/[+/]/)[0];
  return f === "mcs2" || f === "laionb32" ? f : undefined;
}

/** Token ids padded with 0 to the model's context, as the apps do (padding doesn't change the output). */
export function padIds(ids: number[]): number[] {
  const out = new Array(CONTEXT).fill(0);
  ids.slice(0, CONTEXT).forEach((v, i) => (out[i] = v));
  return out;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

export interface Hit { id: string; score: number }

/** Every vector against the (normalised) query, best match first, nothing cut off: ranked like Immich's smart search
 *  (docs/SEARCH.md). Vectors are normalised already. */
export function rank(query: Float32Array, vectors: Map<string, Float32Array>): Hit[] {
  const hits: Hit[] = [];
  for (const [id, v] of vectors) {
    if (v.length !== query.length) continue;
    let d = 0;
    for (let i = 0; i < v.length; i++) d += v[i] * query[i];
    hits.push({ id, score: d });
  }
  return hits.sort((a, b) => b.score - a.score);
}
