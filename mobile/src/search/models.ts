// The search models: downloaded once from Hugging Face, where they are published, into the app's private storage,
// each checked against its SHA-256 before it is opened. Names, pinned URLs, hashes and sizes come from the one list
// the server and every app share (server/models.json, docs/MODELS.md).
import { Directory, File, Paths } from "expo-file-system";
import N from "../../modules/cf-native/src/CfNativeModule";
import { explicitSearchOffered } from "../store";
import LIST from "../../../server/models.json";

/** The image/text model: MobileCLIP S2, or LAION's uncensored CLIP ViT-B/32 for explicit search (docs/SEARCH.md). */
export type Clip = "mobileclip-s2" | "laion-b32";
/** text: needed by a phone that only searches (another device indexes, docs/SEARCH.md "One device indexes") */
export interface Model { name: string; url: string; sha256: string; size: number; faces?: boolean; clip?: Clip; text?: boolean }

/** What each file is for here; where it comes from is in the shared list. */
const ROLES: Record<string, Omit<Model, "name" | "url" | "sha256" | "size">> = {
  "mobileclip-s2-vision.onnx": { clip: "mobileclip-s2" },
  "mobileclip-s2-text.onnx": { clip: "mobileclip-s2", text: true },
  "nsfw-laion-b32-vision.onnx": { clip: "laion-b32" },
  "nsfw-laion-b32-text.onnx": { clip: "laion-b32", text: true },
  "mobileclip-s2-tokenizer.json": { text: true },
  "yunet-2023mar.onnx": { faces: true },
  "sface-2021dec.onnx": { faces: true },
};

export const MODELS: Model[] = LIST.map((m) => ({ ...m, ...ROLES[m.name] }));

/** Bumped when the models or how their output is used change: entries made with another value are made again. */
const TAGS: Record<Clip, [string, string]> = {
  "mobileclip-s2": ["mcs2+yunet23+sface21/2", "mcs2/2"],
  "laion-b32": ["laionb32+yunet23+sface21/1", "laionb32/1"],
};
export const modelTag = (clip: Clip, faces: boolean) => TAGS[clip][faces ? 0 : 1];
/** The server keeps entries per model family (the tag up to "+" or "/"): mcs2 or laionb32. */
export const family = (clip: Clip) => TAGS[clip][1].split("/")[0];

/** The model every device can search with: the Play build, an older app or a person not allowed explicit search. */
export const STANDARD: Clip = "mobileclip-s2";
/** While explicit search is on, the indexing device keeps MobileCLIP's entries current too (docs/SEARCH.md "Explicit
 *  search"), so devices that only read MobileCLIP's always find a complete index. */
export const keepsStandard = (clip: Clip, indexes = true) => indexes && clip !== STANDARD;
const good = (tag: string | undefined, faces: boolean, clip: Clip) => tag === modelTag(clip, true) || (!faces && tag === modelTag(clip, false));
/** What the indexing device still computes for an item, from its entries' tags (the account's model's and, alongside
 *  LAION, MobileCLIP's): those not current. Empty when the item is done. */
export function toCompute(tag: string | undefined, standard: string | undefined, faces: boolean, clip: Clip, indexes = true): Clip[] {
  const out: Clip[] = good(tag, faces, clip) ? [] : [clip];
  if (keepsStandard(clip, indexes) && !good(standard, faces, STANDARD)) out.push(STANDARD);
  return out;
}

export const modelDir = () => new Directory(Paths.document, "models");
const path = (m: Model) => new File(modelDir(), m.name).uri.replace(/^file:\/\//, "");

/** What this phone needs: everything for the model if it indexes, only the text side if it only searches. Indexing
 *  with LAION also needs MobileCLIP's image model (its text model stays away: this phone searches with LAION). */
export const needed = (faces: boolean, clip: Clip, indexes = true) =>
  MODELS.filter((m) => (indexes ? faces || !m.faces : m.text) && (!m.clip || m.clip === clip || (keepsStandard(clip, indexes) && m.clip === STANDARD && !m.text)));
export const downloadSize = (faces: boolean, clip: Clip, indexes = true) =>
  needed(faces, clip, indexes).filter((m) => !new File(modelDir(), m.name).exists).reduce((n, m) => n + m.size, 0);

let checked = new Set<string>(); // verified this run: the hash is computed once per start

export async function haveModels(faces: boolean, clip: Clip, indexes = true): Promise<boolean> {
  for (const m of needed(faces, clip, indexes)) {
    if (checked.has(m.name)) continue;
    if (!new File(modelDir(), m.name).exists) return false;
    if (!(await N.checkModel(path(m), m.sha256))) { try { new File(modelDir(), m.name).delete(); } catch { /* gone */ } return false; }
    checked.add(m.name);
  }
  return true;
}

let downloading: Promise<void> | null = null;
let listeners = new Set<(done: number, total: number) => void>();

/** Downloads what is missing; onProgress gets bytes of all files together. A second call joins the running download. */
export function downloadModels(faces: boolean, clip: Clip, onProgress: (done: number, total: number) => void, indexes = true): Promise<void> {
  listeners.add(onProgress);
  downloading ??= fetchAll(faces, clip, indexes, (d, t) => listeners.forEach((f) => f(d, t))).finally(() => { downloading = null; listeners = new Set(); });
  return downloading;
}

/** Deletes the other image/text model's files (switching: 600 MB of LAION shouldn't stay after going back, and
 *  MobileCLIP not after going to LAION, except its image model on the phone that indexes); the tokenizer and the face
 *  models are shared and stay. Returns what went. */
export function dropOtherModels(clip: Clip, indexes = true): string[] {
  const gone: string[] = [];
  const keep = new Set(needed(true, clip, indexes).map((m) => m.name));
  for (const m of MODELS) {
    if (keep.has(m.name) || (!m.clip && indexes)) continue; // face models stay while indexing (faces may be turned on)
    try { const f = new File(modelDir(), m.name); if (f.exists) { f.delete(); gone.push(m.name); } } catch { /* next time */ }
    for (const p of [".part"]) try { const f = new File(modelDir(), m.name + p); if (f.exists) f.delete(); } catch { /* next time */ }
    checked.delete(m.name);
  }
  return gone;
}

async function fetchAll(faces: boolean, clip: Clip, indexes: boolean, onProgress: (done: number, total: number) => void) {
  // the Play build never offers explicit search, so it never fetches that model, whatever asked for it (store.ts)
  if (clip !== "mobileclip-s2" && !explicitSearchOffered()) throw new Error("Explicit search isn't available in this version.");
  modelDir().create({ intermediates: true, idempotent: true });
  const list = needed(faces, clip, indexes).filter((m) => !checked.has(m.name));
  const total = list.reduce((n, m) => n + m.size, 0);
  let before = 0;
  const sub = N.addListener("onModelProgress", (e) => {
    const m = list.find((x) => path(x) === e.path);
    if (m) onProgress(before + e.done, total);
  });
  try {
    for (const m of list) {
      await N.downloadModel(m.url, path(m), m.sha256, m.size);
      checked.add(m.name);
      before += m.size;
      onProgress(before, total);
    }
  } finally {
    sub.remove();
  }
}

export function deleteModels() {
  N.visionClose();
  checked = new Set();
  try { const d = modelDir(); if (d.exists) d.delete(); } catch { /* best effort */ }
}

export const tokenizerFile = () => new File(modelDir(), "mobileclip-s2-tokenizer.json");
export const modelPath = () => modelDir().uri.replace(/^file:\/\//, "");
