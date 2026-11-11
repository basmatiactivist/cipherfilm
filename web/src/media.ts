import type { Edit, Orig } from "./edit/edit";
import { fileVideoLocation } from "./places/videoLocation";

export const THUMB_PX = 640; // sharp enough for a wide photo stretched across a row on a 2x screen
export const PREVIEW_PX = 2048;

export interface ItemMeta {
  name: string;
  mime: string;
  size: number;
  lastModified: number;
  /** Capture time in ms since epoch; falls back to the file's date. */
  capture_ts: number;
  width?: number;
  height?: number;
  /** seconds, videos only */
  duration?: number;
  make?: string;
  model?: string;
  gps?: { lat: number; lon: number };
  /** turned and cropped (edit/edit.ts); the encrypted original stays as it was */
  edit?: Edit;
  /** the date and place before the person changed them */
  orig?: Orig;
}

export const isHeic = (f: Pick<File, "type" | "name">): boolean => /^image\/hei[cf]/.test(f.type) || /\.(heic|heif)$/i.test(f.name);
export const kindOf = (f: Pick<File, "type" | "name">): "image" | "video" | "other" =>
  f.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(f.name) ? "video" : f.type.startsWith("image/") || isHeic(f) ? "image" : "other";
/** The kind of an item as its encrypted, authenticated metadata says, by the same rule as at upload: never the
 *  server's plain `kind`, which a malicious server could change to route a photo's bytes to the video player. */
export const kindOfMeta = (m: Pick<ItemMeta, "mime" | "name">): "image" | "video" | "other" => kindOf({ type: m.mime, name: m.name });

export async function readMeta(f: File, dims?: { width: number; height: number; duration?: number }): Promise<ItemMeta> {
  const meta: ItemMeta = { name: f.name, mime: f.type || "application/octet-stream", size: f.size, lastModified: f.lastModified, capture_ts: f.lastModified, ...dims };
  if (kindOf(f) === "image") {
    const { default: exifr } = await import("exifr/dist/full.esm.mjs"); // only uploads need it; outside the try, so a failed load isn't taken for a photo without EXIF
    try {
      const x = await exifr.parse(f, { pick: ["DateTimeOriginal", "CreateDate", "Make", "Model"] });
      const d = x?.DateTimeOriginal ?? x?.CreateDate;
      if (d instanceof Date && !isNaN(+d)) meta.capture_ts = +d;
      if (x?.Make) meta.make = String(x.Make);
      if (x?.Model) meta.model = String(x.Model);
      const g = await exifr.gps(f);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) meta.gps = { lat: g.latitude, lon: g.longitude };
    } catch {
      /* no readable EXIF: file date stays */
    }
  }
  if (kindOf(f) === "video") {
    const g = await fileVideoLocation(f);
    if (g) meta.gps = g;
  }
  return meta;
}

export interface Decoded { source: CanvasImageSource; width: number; height: number; duration?: number; close: () => void }

/** HEIC photos are a few MB; anything this large is not decoded for a thumbnail (it still uploads). */
const HEIC_MAX_BYTES = 256 * 1024 * 1024;

async function decodeHeic(f: File): Promise<Decoded> {
  if (f.size > HEIC_MAX_BYTES) throw new Error("HEIC file is too large to preview");
  const worker = new Worker(new URL("./heic.worker.ts", import.meta.url), { type: "module" });
  try {
    const buf = await f.arrayBuffer();
    const r = await new Promise<{ width: number; height: number; buffer: ArrayBuffer }>((res, rej) => {
      const t = setTimeout(() => rej(new Error("HEIC decode timed out")), 60_000); // like a video frame: give up, upload anyway
      worker.onmessage = (e) => { clearTimeout(t); e.data.ok ? res(e.data) : rej(new Error(e.data.error)); };
      worker.onerror = () => { clearTimeout(t); rej(new Error("HEIC decoder failed to start")); };
      worker.postMessage(buf, [buf]);
    });
    if (!(r.width > 0 && r.height > 0) || r.width * r.height > MAX_PIXELS || r.buffer.byteLength !== r.width * r.height * 4) throw new Error("image is too large to preview");
    const canvas = document.createElement("canvas");
    canvas.width = r.width;
    canvas.height = r.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
    return { source: canvas, width: r.width, height: r.height, close: () => { canvas.width = canvas.height = 0; } };
  } finally {
    worker.terminate();
  }
}

/** Browsers decode JPEG/PNG/WebP natively (EXIF orientation applied); HEIC goes through the WASM decoder. */
export const MAX_PIXELS = 256_000_000; // refuse decompression bombs instead of crashing the tab

export async function decodeImage(f: File): Promise<Decoded> {
  if (isHeic(f)) return decodeHeic(f);
  const bmp = await createImageBitmap(f);
  if (bmp.width * bmp.height > MAX_PIXELS) { bmp.close(); throw new Error("image is too large to preview"); }
  return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
}

// ---- thumbnails off the main thread (images the browser decodes itself; HEIC and video stay on the main path) ----

interface Made { width: number; height: number; thumb: Uint8Array; preview: Uint8Array }
let pool: Worker[] = [];
let nextReq = 1;
let rr = 0;
const waiting = new Map<number, { res: (m: Made) => void; rej: (e: Error) => void }>();

const workerSupported = () => !(() => { try { return localStorage.getItem("cf-noworker") === "1"; } catch { return false; } })() && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";

function getWorker(): Worker {
  if (!pool.length) {
    const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
    pool = Array.from({ length: n }, () => {
      const w = new Worker(new URL("./media.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const p = waiting.get(e.data.id);
        if (!p) return;
        waiting.delete(e.data.id);
        e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error));
      };
      w.onerror = () => { for (const [id, p] of waiting) { waiting.delete(id); p.rej(new Error("image worker failed")); } pool = []; };
      return w;
    });
  }
  return pool[rr++ % pool.length];
}

/** Thumbnail and preview made in a worker. Returns null when this file or browser needs the main-thread path. */
export async function thumbsInWorker(f: File): Promise<Made | null> {
  if (!workerSupported() || kindOf(f) !== "image" || isHeic(f)) return null;
  const id = nextReq++;
  try {
    return await new Promise<Made>((res, rej) => {
      waiting.set(id, { res, rej });
      getWorker().postMessage({ id, file: f, thumbPx: THUMB_PX, previewPx: PREVIEW_PX, maxPixels: MAX_PIXELS } satisfies Record<string, unknown>);
    });
  } catch (e) {
    console.warn("worker thumbnails failed, using the main thread:", e);
    return null;
  }
}

export async function toJpeg(d: Decoded, maxPx: number, quality: number): Promise<Uint8Array> {
  const scale = Math.min(1, maxPx / Math.max(d.width, d.height));
  const w = Math.max(1, Math.round(d.width * scale)), h = Math.max(1, Math.round(d.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no alpha
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(d.source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", quality));
  c.width = c.height = 0;
  if (!blob) throw new Error("could not create a thumbnail");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Grabs a still frame from a local video file (before encryption) for the thumbnail.
 * Rejects when this browser can't decode the file, e.g. HEVC in some browsers; the upload then has no thumbnail.
 */
export async function decodeVideoFrame(f: File): Promise<Decoded> {
  const url = URL.createObjectURL(f);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  const cleanup = () => { v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); };
  const once = (ev: string) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("video decode timed out")), 15_000);
      v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
      v.addEventListener("error", () => { clearTimeout(t); rej(new Error("this browser can't decode the video")); }, { once: true });
    });
  try {
    v.src = url;
    await once("loadeddata");
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const t = Math.min(1, duration / 3);
    if (t > 0) { const seeked = once("seeked"); v.currentTime = t; await seeked; }
    if (!v.videoWidth || !v.videoHeight) throw new Error("no video frame");
    return { source: v, width: v.videoWidth, height: v.videoHeight, duration, close: cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
