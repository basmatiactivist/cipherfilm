// Edits on the phone (docs/EDITING.md), with the rules shared with the web app (@edit/edit): the original is decrypted
// into the outbox folder (cleared like every decrypted copy, outbox.ts), made upright by Android's decoder (N.jpeg),
// turned and cropped by expo-image-manipulator, and the new thumbnail and preview go up encrypted with the item's key.
// The encrypted original on the server is never changed. The metadata (the edit, a new date or place) goes up
// encrypted like any other change.
import { Directory, File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { b64, getSodium } from "@crypto/sodium";
import { encryptMeta, encryptPreview, encryptThumb } from "@crypto/item";
import { editedName, normEdit, sameEdit, turnedSize, versionName, withPicture, type Edit } from "@edit/edit";
import { withExif } from "@edit/exif";
import N from "../modules/cf-native/src/CfNativeModule";
import { api, ApiError, putBytes } from "./api";
import { forgetPictures, type Item, type ItemMeta } from "./library";
import { decryptTo, OUT, safeName, sweepLater } from "./outbox";
import { session } from "./session";
import { t } from "./i18n";
import { PREVIEW_PX, THUMB_PX } from "./upload";

/** The largest photo edited on the phone (it is decrypted whole into the outbox). */
export const EDIT_LIMIT = 200 * 1024 * 1024;
/** The longest side the phone decodes a photo at for editing; a larger one is scaled down first. */
export const SOURCE_MAX = 8192;

export const canEditPicture = (it: Item) => it.kind === "image" && !it.broken && !!it.itemKey && it.size <= EDIT_LIMIT;
/** Not in the demo, not in the trash, readable; videos get only a new date or place. */
export const canEdit = (it: Item) => !session().me?.demo && !it.trashed_at && !it.broken && !!it.itemKey && !!it.meta && (it.kind === "image" || it.kind === "video");

/**
 * What expo-image-manipulator does to an upright picture of w × h pixels for the edit, in its order: turn clockwise,
 * crop (in the turned picture's pixels), then scale to at most maxPx on the longer side (0: as it is).
 */
export function manipulatorSteps(w: number, h: number, e: Edit | undefined, maxPx: number) {
  const n = normEdit(e);
  const rot = n?.rot ?? 0;
  const t = turnedSize(w, h, rot);
  let cw = t.w, ch = t.h;
  let crop: { originX: number; originY: number; width: number; height: number } | undefined;
  if (n?.crop) {
    const x = Math.round(n.crop.x * t.w), y = Math.round(n.crop.y * t.h);
    cw = Math.max(1, Math.min(t.w - x, Math.round(n.crop.w * t.w)));
    ch = Math.max(1, Math.min(t.h - y, Math.round(n.crop.h * t.h)));
    crop = { originX: x, originY: y, width: cw, height: ch };
  }
  const scale = maxPx > 0 ? Math.min(1, maxPx / Math.max(cw, ch)) : 1;
  const resize = scale < 1 ? { width: Math.max(1, Math.round(cw * scale)), height: Math.max(1, Math.round(ch * scale)) } : undefined;
  return { rotate: rot || undefined, crop, resize };
}

/** The size to decode the original at so that the crop still fills `want` pixels: never more than SOURCE_MAX. */
export function sourcePx(e: Edit | undefined, want: number): number {
  const c = normEdit(e)?.crop;
  const part = c ? Math.max(c.w, c.h) : 1;
  return Math.min(SOURCE_MAX, Math.ceil(want / part));
}

/** "2024-05-01" and "14:03" in this phone's time zone. */
export function dateParts(ts: number): { date: string; time: string } {
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** The time typed in, or null when it isn't one ("2024-02-30", "25:00"). Seconds are kept from `keep` (ms). */
export function parseDateTime(date: string, time: string, keep = 0): number | null {
  const dm = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(date), tm = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d, h, mi] = [+dm[1], +dm[2], +dm[3], +tm[1], +tm[2]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || y < 1800 || y > 2200) return null;
  const sec = new Date(keep).getSeconds();
  const out = new Date(y, mo - 1, d, h, mi, sec);
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) return null; // the 30th of February
  return out.getTime();
}

// ---- on the phone ----

const editDir = () => new Directory(OUT(), "edit");

/** The original, decrypted into a folder of its own in the outbox (closeOriginal removes it). */
export interface Opened { dir: Directory; orig: File; n: number }
/** A picture file the manipulator can read: the original upright, in the same folder. */
export interface Upright { uri: string; width: number; height: number }

export async function openOriginal(it: Item, onBytes: (n: number) => void = () => {}): Promise<Opened> {
  const s = await getSodium();
  const dir = new Directory(editDir(), s.to_hex(s.randombytes_buf(8)));
  dir.create({ intermediates: true, idempotent: true });
  sweepLater();
  try {
    return { dir, orig: await decryptTo(dir, it, new Set(), onBytes), n: 0 };
  } catch (e) {
    try { dir.delete(); } catch { /* the outbox is cleared anyway */ }
    throw e;
  }
}

export function closeOriginal(o: Opened | null | undefined) {
  try { if (o?.dir.exists) o.dir.delete(); } catch { /* the outbox is cleared anyway */ }
}

/** The original decoded upright (EXIF orientation applied, as Android's decoder does), at most maxPx on its longer
 *  side, as a JPEG file next to it. */
export async function upright(o: Opened, maxPx: number): Promise<Upright> {
  const got = await N.jpeg(o.orig.uri, false, maxPx, 95);
  if (!got) throw new Error(t("This photo couldn't be opened for editing on this phone."));
  const f = new File(o.dir, `work-${++o.n}.jpg`);
  f.create();
  f.write(got.bytes);
  got.bytes.fill(0);
  return { uri: f.uri, width: got.width, height: got.height };
}

function dropFile(uri: string) {
  try { const f = new File(uri); if (f.exists) f.delete(); } catch { /* the outbox is cleared anyway */ }
}

/** The edited picture as JPEG bytes. */
export async function render(src: Upright, e: Edit | undefined, maxPx: number, quality: number): Promise<Uint8Array> {
  const steps = manipulatorSteps(src.width, src.height, e, maxPx);
  let ctx = ImageManipulator.manipulate(src.uri);
  if (steps.rotate) ctx = ctx.rotate(steps.rotate);
  if (steps.crop) ctx = ctx.crop(steps.crop);
  if (steps.resize) ctx = ctx.resize(steps.resize);
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ compress: quality, format: SaveFormat.JPEG });
  (ref as { release?: () => void }).release?.();
  (ctx as { release?: () => void }).release?.();
  try { return await new File(out.uri).bytes(); } finally { dropFile(out.uri); }
}

const tooOld = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405)
  ? new Error(t("Couldn't save the edited photo: this server can't store edits yet. Ask whoever runs it to update it.")) : e;

/** New thumbnail and preview drawn with the edit, stored with the item; resolves with the version name they go by. */
async function storePictures(it: Item, src: Upright, e: Edit | undefined): Promise<string> {
  const s = await getSodium();
  const thumb = await render(src, e, THUMB_PX, 0.82);
  const preview = await render(src, e, PREVIEW_PX, 0.85);
  try {
    await putBytes(`/api/items/${it.id}/replace/thumb`, encryptThumb(s, thumb, it.itemKey!, it.id));
    await putBytes(`/api/items/${it.id}/replace/preview`, encryptPreview(s, preview, it.itemKey!, it.id));
  } catch (x) { throw tooOld(x); } finally { thumb.fill(0); preview.fill(0); }
  return versionName(s.randombytes_buf(8));
}

/**
 * Saves the new metadata; when its turn or crop differs from the stored one, new pictures are made first from the
 * original (`opened`, or decrypted now), so a device that sees the new edit finds its pictures. `onStep` says what
 * happens (for the progress).
 */
export async function saveEdit(it: Item, next: ItemMeta, onStep?: (label: string, progress: number) => void, opened?: Opened | null): Promise<void> {
  if (session().me?.demo) throw new Error(t("This is the public demo: changes are turned off."));
  if (!session().masterKey || !it.itemKey) throw new Error(t("Unlock your library first."));
  let meta = next;
  const newPictures = !sameEdit(it.meta?.edit, next.edit);
  if (newPictures) {
    const e = normEdit(next.edit);
    let done = 0;
    onStep?.(t("Decrypting the original"), 0);
    const o = opened ?? await openOriginal(it, (n) => onStep?.(t("Decrypting the original"), (done += n) / it.size));
    let src: Upright | undefined;
    try {
      onStep?.(t("Making the new pictures"), 0);
      src = await upright(o, sourcePx(e, PREVIEW_PX));
      meta = withPicture(next, e, await storePictures(it, src, e));
    } finally {
      if (src) dropFile(src.uri);
      if (!opened) closeOriginal(o);
    }
  }
  onStep?.(t("Saving"), 0);
  const s = await getSodium();
  await api("PUT", `/api/items/${it.id}/meta`, { meta_enc: b64(s, encryptMeta(s, meta, it.itemKey, it.id)) });
  if (newPictures) forgetPictures(it.id);
}

/** For sharing and saving: the photo as edited, at full size (up to SOURCE_MAX), a JPEG with the date and place as last
 *  set in its EXIF, written into `dir` next to the other copies. */
export async function editedCopyTo(dir: Directory, it: Item, used: Set<string>, onBytes: (n: number) => void): Promise<File> {
  const o = await openOriginal(it, onBytes);
  try {
    const src = await upright(o, SOURCE_MAX);
    const jpeg = await render(src, normEdit(it.meta?.edit), 0, 0.92);
    const out = withExif(jpeg, { ts: it.meta?.capture_ts, gps: it.meta?.gps });
    jpeg.fill(0);
    const f = new File(dir, safeName(editedName(it.meta?.name ?? "photo"), it.id, used));
    f.create();
    f.write(out);
    out.fill(0);
    return f;
  } finally { closeOriginal(o); }
}
