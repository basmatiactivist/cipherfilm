// The search models: downloaded once from Hugging Face, where they are published, into the app's private storage,
// each checked against its SHA-256 before it is opened. Names, pinned URLs, hashes and sizes come from the one list
// the server and every app share (server/models.json, docs/MODELS.md).
import { Directory, File, Paths } from "expo-file-system";
import N from "../../modules/cf-native/src/CfNativeModule";
import LIST from "../../../server/models.json";
import { t } from "../i18n";

/** The image/text model: LAION's OpenCLIP ViT-B/32, for everyone (docs/SEARCH.md, docs/MODELS.md). MobileCLIP S2,
 *  used before, was dropped for its license; explicit content is filtered from search instead of using another model
 *  (@websearch/explicit). The parameter stays in the functions below, with this one value. */
export type Clip = "clip-b32";
export const CLIP: Clip = "clip-b32";
/** text: needed by a phone that only searches (another device indexes, docs/SEARCH.md "One device indexes") */
export interface Model { name: string; url: string; sha256: string; size: number; faces?: boolean; clip?: Clip; text?: boolean }

/** What each file is for here; where it comes from is in the shared list. */
const ROLES: Record<string, Omit<Model, "name" | "url" | "sha256" | "size">> = {
  "clip-b32-vision.onnx": { clip: "clip-b32" },
  "clip-b32-text.onnx": { clip: "clip-b32", text: true },
  "clip-b32-tokenizer.json": { text: true },
  "yunet-2023mar.onnx": { faces: true },
  "sface-2021dec.onnx": { faces: true },
};

export const MODELS: Model[] = LIST.map((m) => ({ ...m, ...ROLES[m.name] }));

/** Bumped when the models or how their output is used change: entries made with another value are made again. The
 *  tag is the one explicit search's LAION entries had, so those are kept as they are. */
const TAGS: Record<Clip, [string, string]> = {
  "clip-b32": ["laionb32+yunet23+sface21/1", "laionb32/1"],
};
export const modelTag = (clip: Clip, faces: boolean) => TAGS[clip][faces ? 0 : 1];
/** The server keeps entries per model family (the tag up to "+" or "/"): laionb32. */
export const family = (clip: Clip) => TAGS[clip][1].split("/")[0];

/** MobileCLIP's entries, made by this app before (and by older apps still): read only by the indexing device, which
 *  takes their faces over into the new entries (the people document names faces by their place in an entry, and no
 *  face is looked for twice), then deletes them (docs/SEARCH.md "One model"). */
export const LEGACY_FAMILY = "mcs2";
export const legacyFaces = (tag: string | undefined) => !!tag && tag.startsWith("mcs2+yunet23+sface21/");

const good = (tag: string | undefined, faces: boolean, clip: Clip) => tag === modelTag(clip, true) || (!faces && tag === modelTag(clip, false));
/** What the indexing device still computes for an item, from its entry's tag: nothing when it is current. */
export function toCompute(tag: string | undefined, faces: boolean, clip: Clip = CLIP): Clip[] {
  return good(tag, faces, clip) ? [] : [clip];
}

export const modelDir = () => new Directory(Paths.document, "models");
const path = (m: Model) => new File(modelDir(), m.name).uri.replace(/^file:\/\//, "");

/** What this phone needs: everything if it indexes, only the text side if it only searches. */
export const needed = (faces: boolean, clip: Clip, indexes = true) =>
  MODELS.filter((m) => (indexes ? faces || !m.faces : m.text) && (!m.clip || m.clip === clip));
export const downloadSize = (faces: boolean, clip: Clip, indexes = true) => {
  tidyOldFiles();
  return needed(faces, clip, indexes).filter((m) => !new File(modelDir(), m.name).exists).reduce((n, m) => n + m.size, 0);
};

/** Files earlier versions downloaded: explicit search's LAION model is everyone's model now, under neutral names (the
 *  same bytes: moved, not downloaded again; still checked by SHA-256 before use); MobileCLIP's files are deleted, its
 *  license doesn't allow their use. Cheap: a few checks whether files exist. */
export const OLD_FILES: Record<string, string | null> = {
  "nsfw-laion-b32-vision.onnx": "clip-b32-vision.onnx",
  "nsfw-laion-b32-text.onnx": "clip-b32-text.onnx",
  "mobileclip-s2-vision.onnx": null,
  "mobileclip-s2-text.onnx": null,
  "mobileclip-s2-tokenizer.json": null,
};
let tidied = false;
export function tidyOldFiles() {
  if (tidied) return;
  tidied = true;
  for (const [old, now] of Object.entries(OLD_FILES)) {
    for (const ext of ["", ".part"]) {
      try {
        const f = new File(modelDir(), old + ext);
        if (!f.exists) continue;
        const to = now && !ext ? new File(modelDir(), now) : null;
        if (to && !to.exists) f.moveSync(to); else f.delete();
      } catch { tidied = false; /* next time */ }
    }
  }
}

let checked = new Set<string>(); // verified this run: the hash is computed once per start

// ---- the yes to download (docs/MODELS.md) ----
// Hugging Face is a third party: it sees this phone's IP address. So nothing is fetched from there before the person
// agreed, for the exact files (their SHA-256): explicit search's model, the face models or a new model in a later
// release ask again. The answer is this phone's (any account), kept next to the models, so deleting them (turning
// search off) withdraws it. Files already here, downloaded before this question existed, need no yes: they aren't
// downloaded again.

/** at: when the yes was given; null when the files were found already downloaded */
interface Agreed { at: number | null; sha: string[] }
const consentFile = () => new File(modelDir(), "consent.json");
let agreed: Agreed | null | undefined; // undefined: not read yet
const consentSubs = new Set<() => void>();
export const onConsentChange = (f: () => void) => { consentSubs.add(f); return () => { consentSubs.delete(f); }; };

function readAgreed(): Agreed | null {
  if (agreed !== undefined) return agreed;
  try {
    const f = consentFile();
    const v = f.exists ? JSON.parse(f.textSync()) : null;
    agreed = v && Array.isArray(v.sha) ? { at: typeof v.at === "number" ? v.at : null, sha: v.sha.filter((x: unknown) => typeof x === "string") } : null;
  } catch { agreed = null; }
  return agreed;
}

function writeAgreed(v: Agreed | null) {
  agreed = v;
  try {
    if (v) { modelDir().create({ intermediates: true, idempotent: true }); consentFile().write(JSON.stringify(v)); }
    else if (consentFile().exists) consentFile().delete();
  } catch { /* kept for this run */ }
  consentSubs.forEach((f) => f());
}

const onPhone = (m: Model) => checked.has(m.name) || new File(modelDir(), m.name).exists;

/** What a download would fetch that the person hasn't agreed to: empty when nothing needs asking. (After haveModels,
 *  which removes a file with the wrong hash, a model update shows here as a missing file.) */
export const unagreed = (faces: boolean, clip: Clip, indexes = true) => {
  tidyOldFiles();
  const a = readAgreed();
  return needed(faces, clip, indexes).filter((m) => !onPhone(m) && !a?.sha.includes(m.sha256));
};

/** The yes: what using these settings needs may be downloaded. */
export function agreeModels(faces: boolean, clip: Clip, indexes = true) {
  const a = readAgreed();
  writeAgreed({ at: Date.now(), sha: [...new Set([...(a?.sha ?? []), ...needed(faces, clip, indexes).map((m) => m.sha256)])] });
}

/** For the search settings: when the models on this phone were downloaded and how big they are; null when none.
 *  Models from before this question was asked are taken as agreed, dated by their files. */
export function modelsOnPhone(): { at: number | null; bytes: number } | null {
  tidyOldFiles();
  const here = MODELS.filter((m) => new File(modelDir(), m.name).exists);
  if (!here.length) return null;
  let a = readAgreed();
  if (!a || here.some((m) => !a!.sha.includes(m.sha256))) {
    const times = here.map((m) => { try { return new File(modelDir(), m.name).modificationTime ?? null; } catch { return null; } }).filter((x): x is number => !!x);
    a = { at: a?.at ?? (times.length ? Math.min(...times) : null), sha: [...new Set([...(a?.sha ?? []), ...here.map((m) => m.sha256)])] };
    writeAgreed(a);
  }
  return { at: a.at, bytes: here.reduce((n, m) => n + m.size, 0) };
}

/** Thrown by downloadModels for a file the person hasn't agreed to download. */
export class NeedsConsent extends Error {
  constructor(readonly bytes: number) { super(t("Search needs your OK to download the models.")); }
}

export async function haveModels(faces: boolean, clip: Clip, indexes = true): Promise<boolean> {
  tidyOldFiles();
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

/** Deletes what this phone doesn't need: the image model where it only searches (another device indexes); the face
 *  models stay while it indexes (faces may be turned on). Returns what went. */
export function dropOtherModels(clip: Clip, indexes = true): string[] {
  const gone: string[] = [];
  const keep = new Set(needed(true, clip, indexes).map((m) => m.name));
  for (const m of MODELS) {
    if (keep.has(m.name) || (!m.clip && indexes)) continue; // face models stay while indexing (faces may be turned on)
    try { const f = new File(modelDir(), m.name); if (f.exists) { f.delete(); gone.push(m.name); } } catch { /* next time */ }
    for (const p of [".part"]) try { const f = new File(modelDir(), m.name + p); if (f.exists) f.delete(); } catch { /* next time */ }
    checked.delete(m.name);
  }
  // what went is asked for again before it comes back
  const a = readAgreed();
  if (gone.length && a) writeAgreed({ ...a, sha: a.sha.filter((x) => !MODELS.some((m) => gone.includes(m.name) && m.sha256 === x)) });
  return gone;
}

async function fetchAll(faces: boolean, clip: Clip, indexes: boolean, onProgress: (done: number, total: number) => void) {
  tidyOldFiles();
  // nothing goes to Hugging Face without the yes, whatever asked for it (above): a file already here with the right
  // hash isn't downloaded and needs none
  const a = readAgreed();
  const ask: Model[] = [];
  for (const m of needed(faces, clip, indexes)) {
    if (checked.has(m.name) || a?.sha.includes(m.sha256)) continue;
    if (new File(modelDir(), m.name).exists && (await N.checkModel(path(m), m.sha256))) { checked.add(m.name); continue; }
    ask.push(m);
  }
  if (ask.length) throw new NeedsConsent(ask.reduce((n, m) => n + m.size, 0));
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

/** Turning search off: the models go, and with them the yes to download them (asked again next time). */
export function deleteModels() {
  N.visionClose();
  checked = new Set();
  try { const d = modelDir(); if (d.exists) d.delete(); } catch { /* best effort */ }
  writeAgreed(null);
}

export const tokenizerFile = () => new File(modelDir(), "clip-b32-tokenizer.json");
export const modelPath = () => modelDir().uri.replace(/^file:\/\//, "");
