// The search models: downloaded once from the person's own server (which ships them, see Dockerfile) into the app's
// private storage, each checked against the SHA-256 below before it is opened. Same files and hashes as the Dockerfile.
import { Directory, File, Paths } from "expo-file-system";
import N from "../../modules/cf-native/src/CfNativeModule";

/** The image/text model: MobileCLIP S2, or LAION's uncensored CLIP ViT-B/32 for explicit search (docs/SEARCH.md). */
export type Clip = "mobileclip-s2" | "laion-b32";
/** text: needed by a phone that only searches (another device indexes, docs/SEARCH.md "One device indexes") */
export interface Model { name: string; sha256: string; size: number; faces?: boolean; clip?: Clip; text?: boolean }

export const MODELS: Model[] = [
  { name: "mobileclip-s2-vision.onnx", sha256: "d28b92d7a3a6ba99bd000cce5c91678c0e279dc934c887a3785908a811872a6c", size: 143020962, clip: "mobileclip-s2" },
  { name: "mobileclip-s2-text.onnx", sha256: "f8aaa97cf17fbadd78b0bd6d5f6a1c57f712402cacc3055ea92c1a3331357dfe", size: 64117260, clip: "mobileclip-s2", text: true },
  { name: "nsfw-laion-b32-vision.onnx", sha256: "b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c", size: 351613724, clip: "laion-b32" },
  { name: "nsfw-laion-b32-text.onnx", sha256: "48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722", size: 254193396, clip: "laion-b32", text: true },
  { name: "mobileclip-s2-tokenizer.json", sha256: "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85", size: 2224081, text: true },
  { name: "yunet-2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", size: 232589, faces: true },
  { name: "sface-2021dec.onnx", sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79", size: 38696353, faces: true },
];

/** Bumped when the models or how their output is used change: entries made with another value are made again. */
const TAGS: Record<Clip, [string, string]> = {
  "mobileclip-s2": ["mcs2+yunet23+sface21/2", "mcs2/2"],
  "laion-b32": ["laionb32+yunet23+sface21/1", "laionb32/1"],
};
export const modelTag = (clip: Clip, faces: boolean) => TAGS[clip][faces ? 0 : 1];
/** The server keeps entries per model family (the tag up to "+" or "/"): mcs2 or laionb32. */
export const family = (clip: Clip) => TAGS[clip][1].split("/")[0];

export const modelDir = () => new Directory(Paths.document, "models");
const path = (m: Model) => new File(modelDir(), m.name).uri.replace(/^file:\/\//, "");

/** What this phone needs: everything for the model if it indexes, only the text side if it only searches. */
export const needed = (faces: boolean, clip: Clip, indexes = true) =>
  MODELS.filter((m) => (indexes ? faces || !m.faces : m.text) && (!m.clip || m.clip === clip));
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
export function downloadModels(server: string, faces: boolean, clip: Clip, onProgress: (done: number, total: number) => void, indexes = true): Promise<void> {
  listeners.add(onProgress);
  downloading ??= fetchAll(server, faces, clip, indexes, (d, t) => listeners.forEach((f) => f(d, t))).finally(() => { downloading = null; listeners = new Set(); });
  return downloading;
}

/** Deletes the other image/text model's files (switching: 600 MB of LAION shouldn't stay after going back, and
 *  MobileCLIP not after going to LAION); the tokenizer and the face models are shared and stay. Returns what went. */
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

async function fetchAll(server: string, faces: boolean, clip: Clip, indexes: boolean, onProgress: (done: number, total: number) => void) {
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
      await N.downloadModel(`${server.replace(/\/+$/, "")}/api/models/${m.name}`, path(m), m.sha256, m.size);
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
