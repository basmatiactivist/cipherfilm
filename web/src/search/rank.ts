// Search by what is in a photo, as on Android and Mac (docs/SEARCH.md): the apps stored an image vector per photo in
// the encrypted index; the browser turns the words into a vector with the matching text model and ranks by cosine.
// Pure functions here (models, ranking); the model itself runs in content.worker.ts.
import LIST from "../../../server/models.json";

/** Which model made a vector: the start of the index entry's `m` tag. One model since MobileCLIP S2 was dropped
 *  (docs/MODELS.md): LAION's OpenCLIP ViT-B/32. Entries an older app made with MobileCLIP ("mcs2") are left out. */
export type Family = "laionb32";
export const FAMILY: Family = "laionb32";

/** A file from the one model list (server/models.json): its name, pinned Hugging Face URL, SHA-256 and size. */
export interface ModelFile { file: string; url: string; sha256: string; size: number }

const pinned = (file: string): ModelFile => {
  const m = LIST.find((x) => x.name === file);
  if (!m) throw new Error(`${file} is not in server/models.json`);
  return { file, url: m.url, sha256: m.sha256, size: m.size };
};

export interface TextModel extends ModelFile {
  family: Family;
  /** the export takes int32 ids (Immich's), not int64 */
  int32: boolean;
}

export const TOKENIZER = pinned("clip-b32-tokenizer.json");

export const TEXT_MODELS: Record<Family, TextModel> = {
  laionb32: { family: "laionb32", ...pinned("clip-b32-text.onnx"), int32: true },
};

/** Cache keys of files earlier versions kept (MobileCLIP's, and LAION's text model under its old name): content.ts
 *  moves LAION's to its new key (the same bytes) and deletes the others. */
export const OLD_FILES = { "nsfw-laion-b32-text.onnx": "clip-b32-text.onnx", "mobileclip-s2-text.onnx": null, "mobileclip-s2-tokenizer.json": null } as const;

/** Whether search shows explicit photos: only where an admin allowed explicit search for the person (`user.nsfw`),
 *  they chose it (the people document's `explicit`, for all their devices) and this app offers it (never the Android
 *  app from Google Play). Everything else filters
 *  (explicit.ts). */
export const unfiltered = (o: { allowed: boolean; chosen: boolean; offered?: boolean }) => o.allowed && o.chosen && o.offered !== false;

export const CONTEXT = 77;
/** The browser cache (Cache API) the model files are kept in, under their old /api/models/ URL as the key (files
 *  cached before they came from Hugging Face stay usable). */
export const MODEL_CACHE = "cf-models-1";

/** The model family of an index entry's tag ("laionb32+yunet23+sface21/1", "laionb32/1"), or undefined for others
 *  (MobileCLIP's "mcs2+yunet23+sface21/2" from older apps: its vectors don't compare with this model's). */
export function familyOf(tag: string | undefined): Family | undefined {
  const f = (tag ?? "").split(/[+/]/)[0];
  return f === "laionb32" ? f : undefined;
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
 *  (docs/SEARCH.md). Vectors are normalised already. hidden: items left out (explicit photos in filtered search). */
export function rank(query: Float32Array, vectors: Map<string, Float32Array>, hidden?: Set<string>): Hit[] {
  const hits: Hit[] = [];
  for (const [id, v] of vectors) {
    if (v.length !== query.length || hidden?.has(id)) continue;
    let d = 0;
    for (let i = 0; i < v.length; i++) d += v[i] * query[i];
    hits.push({ id, score: d });
  }
  return hits.sort((a, b) => b.score - a.score);
}
