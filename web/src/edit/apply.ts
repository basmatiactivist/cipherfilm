// Edits in this browser (docs/EDITING.md): the original is downloaded and decrypted here, the new thumbnail and preview
// are drawn from it with the turn and crop, encrypted with the item's key and stored next to it; the original stays
// as it is. The metadata (with the edit, the new date or place) goes up encrypted like any other change.
import { api, ApiError, putBytes } from "../api";
import { b64, getSodium } from "../crypto/sodium";
import { encryptMeta, encryptPreview, encryptThumb } from "../crypto/item";
import { fetchOriginal, type Item } from "../items";
import { decodeImage, PREVIEW_PX, THUMB_PX, type Decoded, type ItemMeta } from "../media";
import { mem } from "../state";
import { drawPlan, normEdit, sameEdit, versionName, withPicture, type Edit } from "./edit";
import { withExif } from "./exif";

/** The largest photo that is edited in the browser (it is decoded whole). */
export const EDIT_LIMIT = 200 * 1024 * 1024;

/** Can this item's picture be turned and cropped here? Videos only get a new date or place. */
export const canEditPicture = (it: Item) => it.kind === "image" && !it.broken && !!it.itemKey && it.size <= EDIT_LIMIT;

/** Can anything be changed at all: not in the demo, not in the trash, readable. */
export const canEdit = (it: Item) => !mem.me?.demo && !it.trashed_at && !it.broken && !!it.itemKey && !!it.meta && (it.kind === "image" || it.kind === "video");

/** The original, decrypted and decoded (EXIF orientation applied, HEIC through its decoder). */
export async function decodeOriginal(it: Item, onProgress?: (done: number, total: number) => void): Promise<Decoded> {
  const blob = await fetchOriginal(it, onProgress);
  const f = new File([blob], it.meta?.name ?? "photo", { type: it.meta?.mime ?? "" });
  return decodeImage(f);
}

/** The edited picture drawn on a canvas, at most maxPx on its longer side (0: full size). */
export function drawEdited(d: Decoded, e: Edit | undefined, maxPx: number): HTMLCanvasElement {
  const p = drawPlan(d.width, d.height, e, maxPx);
  const c = document.createElement("canvas");
  c.width = p.outW;
  c.height = p.outH;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no alpha
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(p.outW / 2, p.outH / 2);
  ctx.rotate((p.rot * Math.PI) / 180);
  ctx.drawImage(d.source, p.sx, p.sy, p.sw, p.sh, -p.dw / 2, -p.dh / 2, p.dw, p.dh);
  return c;
}

export async function canvasJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", quality));
  c.width = c.height = 0;
  if (!blob) throw new Error("Couldn't draw the edited photo.");
  return new Uint8Array(await blob.arrayBuffer());
}

const tooOld = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405)
  ? new Error("Couldn't save the edited photo: this server can't store edits yet. Ask whoever runs it to update it.") : e;

/** New thumbnail and preview for the edit, stored with the item; resolves with the version name they go by. */
export async function storePictures(it: Item, d: Decoded, e: Edit | undefined): Promise<string> {
  const s = await getSodium();
  const thumb = await canvasJpeg(drawEdited(d, e, THUMB_PX), 0.82);
  const preview = await canvasJpeg(drawEdited(d, e, PREVIEW_PX), 0.85);
  try {
    await putBytes(`/api/items/${it.id}/replace/thumb`, encryptThumb(s, thumb, it.itemKey!, it.id));
    await putBytes(`/api/items/${it.id}/replace/preview`, encryptPreview(s, preview, it.itemKey!, it.id));
  } catch (x) { throw tooOld(x); }
  return versionName(s.randombytes_buf(8));
}

/** The item's new metadata, encrypted, to the server; the other devices get it with the next change list. */
export async function storeMeta(it: Item, meta: ItemMeta): Promise<void> {
  if (mem.me?.demo) throw new Error("This is the public demo: changes are turned off.");
  const s = await getSodium();
  await api("PUT", `/api/items/${it.id}/meta`, { meta_enc: b64(s, encryptMeta(s, meta, it.itemKey!, it.id)) });
}

/**
 * Saves new metadata; when its turn or crop differs from the stored one, new pictures are made first (from `decoded`,
 * or from the original, downloaded and decoded now). The pictures go before the metadata, so a device that sees the
 * new edit finds its pictures.
 */
export async function saveEdit(it: Item, next: ItemMeta, decoded?: Decoded | null): Promise<void> {
  let meta = next;
  if (!sameEdit(it.meta?.edit, next.edit)) {
    const d = decoded ?? await decodeOriginal(it);
    try {
      const v = await storePictures(it, d, normEdit(next.edit));
      meta = withPicture(next, normEdit(next.edit), v);
    } finally {
      if (!decoded) d.close();
    }
  }
  await storeMeta(it, meta);
}

/** The photo as edited, at full size, as a JPEG with the date and place (as last set) in its EXIF. */
export async function editedCopy(it: Item, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const d = await decodeOriginal(it, onProgress);
  try {
    const jpeg = await canvasJpeg(drawEdited(d, normEdit(it.meta?.edit), 0), 0.92);
    return new Blob([withExif(jpeg, { ts: it.meta?.capture_ts, gps: it.meta?.gps }) as BlobPart], { type: "image/jpeg" });
  } finally {
    d.close();
  }
}
