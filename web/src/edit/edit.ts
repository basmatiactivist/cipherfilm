// Simple, non-destructive editing (docs/EDITING.md): the encrypted original is never changed. What was done lives in
// the item's encrypted metadata, which only the person's devices can read:
//
//   edit: { rot: 0|90|180|270, crop: { x, y, w, h }, v }   turned clockwise, then cropped; the crop is a fraction of
//                                                           the turned picture (0..1), v names this version of the
//                                                           thumbnail and preview made with it
//   orig: { capture_ts?, gps? }                            what the date and place were before they were changed
//                                                           (gps: null when there was none), for "Revert to original"
//   capture_ts, gps                                        changed in place, so every app (old ones too) sorts and
//                                                           maps the photo by the new values
//
// Pure functions only, shared by the web app and the Android app (mobile/ imports it as @edit/edit); the Mac has the
// same rules in PictureEdit.swift. The metadata comes from whichever device wrote it: everything read is checked.

export type Turn = 0 | 90 | 180 | 270;
/** A fraction of the picture: 0..1 on both axes, from the top left. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Edit { rot?: Turn; crop?: Rect; v?: string }
export interface Gps { lat: number; lon: number }
export interface Orig { capture_ts?: number; gps?: Gps | null }
/** The fields of an item's metadata that editing reads and writes; the rest is kept as it is. */
export interface EditableMeta { capture_ts: number; gps?: Gps; edit?: Edit; orig?: Orig }

/** The smallest crop, as a fraction of a side. */
export const MIN_CROP = 0.02;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A quarter turn from anything: 90, -270, 450 and "90" are all 90; anything else is no turn. */
export function normTurn(r: unknown): Turn {
  const n = typeof r === "number" ? r : typeof r === "string" ? Number(r) : NaN;
  if (!Number.isFinite(n) || n % 90 !== 0) return 0;
  return ((((n % 360) + 360) % 360) as Turn);
}

/** A crop inside the picture, at least MIN_CROP on each side, rounded to 1/10000; undefined for the whole picture
 *  or for something that isn't a rectangle at all. */
export function normRect(r: unknown): Rect | undefined {
  if (!r || typeof r !== "object") return undefined;
  const { x, y, w, h } = r as Record<string, unknown>;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  let x0 = clamp(x as number, 0, 1), y0 = clamp(y as number, 0, 1);
  let x1 = clamp((x as number) + (w as number), 0, 1), y1 = clamp((y as number) + (h as number), 0, 1);
  if (x1 - x0 < MIN_CROP) { x1 = Math.min(1, x0 + MIN_CROP); x0 = x1 - MIN_CROP; }
  if (y1 - y0 < MIN_CROP) { y1 = Math.min(1, y0 + MIN_CROP); y0 = y1 - MIN_CROP; }
  const out = { x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) };
  return out.x === 0 && out.y === 0 && out.w === 1 && out.h === 1 ? undefined : out;
}

/** An edit as written by any device, checked; undefined when it changes nothing. */
export function normEdit(e: unknown): Edit | undefined {
  if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
  const o = e as Record<string, unknown>;
  const out: Edit = {};
  const rot = normTurn(o.rot);
  if (rot) out.rot = rot;
  const crop = normRect(o.crop);
  if (crop) out.crop = crop;
  if (!out.rot && !out.crop) return undefined;
  if (typeof o.v === "string" && /^[0-9a-z]{1,16}$/.test(o.v)) out.v = o.v;
  return out;
}

export const sameEdit = (a: Edit | undefined, b: Edit | undefined): boolean => {
  const x = normEdit(a), y = normEdit(b);
  if (!x || !y) return !x && !y;
  const c = x.crop ?? FULL, d = y.crop ?? FULL;
  return (x.rot ?? 0) === (y.rot ?? 0) && c.x === d.x && c.y === d.y && c.w === d.w && c.h === d.h;
};

/** A rectangle of a picture, where it is after the picture is turned clockwise by `by`. */
export function rotateRect(r: Rect, by: Turn): Rect {
  let out = r;
  for (let i = 0; i < normTurn(by) / 90; i++) out = { x: 1 - (out.y + out.h), y: out.x, w: out.h, h: out.w };
  return { x: round4(out.x), y: round4(out.y), w: round4(out.w), h: round4(out.h) };
}

/** Width and height after turning. */
export const turnedSize = (w: number, h: number, rot: Turn | undefined) => (normTurn(rot) % 180 ? { w: h, h: w } : { w, h });

/** The size of the edited picture for an original of w × h (as the grid lays it out). */
export function editedSize(w: number, h: number, e: Edit | undefined): { w: number; h: number } {
  const n = normEdit(e);
  const t = turnedSize(w, h, n?.rot);
  return { w: t.w * (n?.crop?.w ?? 1), h: t.h * (n?.crop?.h ?? 1) };
}

/** The crop as a fraction of the original, unturned picture. */
export function sourceRect(e: Edit | undefined): Rect {
  const rot = normTurn(e?.rot);
  return rotateRect(normRect(e?.crop) ?? FULL, ((360 - rot) % 360) as Turn);
}

/** Turning the picture once more (by a quarter, clockwise or not) keeps the same part of it cropped. */
export function turn(e: Edit | undefined, by: 90 | -90): Edit | undefined {
  const step = normTurn(by);
  const rot = normTurn((e?.rot ?? 0) + by);
  const crop = e?.crop ? rotateRect(e.crop, step) : undefined;
  return normEdit({ rot, crop });
}

/**
 * How to draw the edited picture from the original of srcW × srcH pixels, at most maxPx on its longer side (0: full
 * size): take the source rectangle sx, sy, sw, sh, scale it to dw × dh, turn it by rot around its centre; the result is
 * outW × outH. The same steps on every platform (canvas, Core Graphics, Android).
 */
export function drawPlan(srcW: number, srcH: number, e: Edit | undefined, maxPx = 0) {
  const s = sourceRect(e);
  const rot = normTurn(e?.rot);
  const sx = Math.round(s.x * srcW), sy = Math.round(s.y * srcH);
  const sw = Math.max(1, Math.min(srcW - sx, Math.round(s.w * srcW))), sh = Math.max(1, Math.min(srcH - sy, Math.round(s.h * srcH)));
  const scale = maxPx > 0 ? Math.min(1, maxPx / Math.max(sw, sh)) : 1;
  const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
  const out = turnedSize(dw, dh, rot);
  return { sx, sy, sw, sh, dw, dh, rot, outW: out.w, outH: out.h };
}

/**
 * The largest crop of the given shape (width:height in pixels, e.g. 4/3) centred on `around` (default: the middle),
 * inside a picture whose turned size is picW × picH. ratio null: the whole picture.
 */
export function ratioRect(ratio: number | null, picW: number, picH: number, around?: Rect): Rect {
  if (!ratio || !(ratio > 0) || !(picW > 0) || !(picH > 0)) return { ...FULL };
  // w and h as fractions: (w * picW) / (h * picH) = ratio
  const k = ratio * picH / picW; // w = k * h
  let h = 1, w = k;
  if (w > 1) { w = 1; h = 1 / k; }
  const cx = around ? around.x + around.w / 2 : 0.5, cy = around ? around.y + around.h / 2 : 0.5;
  const x = clamp(cx - w / 2, 0, 1 - w), y = clamp(cy - h / 2, 0, 1 - h);
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

/** Which part of the crop frame is dragged: an edge, a corner, or the whole frame. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

/**
 * The crop after dragging `handle` by dx, dy (fractions of the turned picture) from `start`. ratio: the shape it keeps
 * (width:height in pixels) or null for free; aspect: picW / picH of the turned picture. Never leaves the picture, never
 * smaller than MIN_CROP.
 */
export function dragCrop(start: Rect, handle: Handle, dx: number, dy: number, ratio: number | null, aspect: number): Rect {
  if (handle === "move") {
    const x = clamp(start.x + dx, 0, 1 - start.w), y = clamp(start.y + dy, 0, 1 - start.h);
    return { x: round4(x), y: round4(y), w: start.w, h: start.h };
  }
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
  const n = handle.includes("n"), s = handle.includes("s"), w = handle.includes("w"), e = handle.includes("e");
  if (!ratio) {
    if (w) x0 = clamp(x0 + dx, 0, x1 - MIN_CROP);
    if (e) x1 = clamp(x1 + dx, x0 + MIN_CROP, 1);
    if (n) y0 = clamp(y0 + dy, 0, y1 - MIN_CROP);
    if (s) y1 = clamp(y1 + dy, y0 + MIN_CROP, 1);
    return { x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0) };
  }
  const k = ratio / aspect; // w = k * h, as fractions
  // the fixed point: the opposite corner, or the middle of the opposite edge
  const ax = w ? x1 : e ? x0 : (x0 + x1) / 2;
  const ay = n ? y1 : s ? y0 : (y0 + y1) / 2;
  // the size the drag asks for, along the axis it moves (both for a corner: the larger wins)
  let wantW = w ? x1 - (x0 + dx) : e ? x1 + dx - x0 : 0;
  let wantH = n ? y1 - (y0 + dy) : s ? y1 + dy - y0 : 0;
  let h = Math.max(wantH, wantW / k);
  if (!(w || e)) h = wantH; else if (!(n || s)) h = wantW / k;
  // the room there is around the fixed point
  const roomX = w ? ax : e ? 1 - ax : 2 * Math.min(ax, 1 - ax);
  const roomY = n ? ay : s ? 1 - ay : 2 * Math.min(ay, 1 - ay);
  const minH = Math.max(MIN_CROP, MIN_CROP / k);
  h = clamp(h, minH, Math.min(roomY, roomX / k));
  const width = k * h;
  x0 = w ? ax - width : e ? ax : ax - width / 2;
  y0 = n ? ay - h : s ? ay : ay - h / 2;
  return { x: round4(clamp(x0, 0, 1 - width)), y: round4(clamp(y0, 0, 1 - h)), w: round4(width), h: round4(h) };
}

// ---- the metadata ----

const validGps = (g: unknown): g is Gps => !!g && typeof g === "object" && Number.isFinite((g as Gps).lat) && Number.isFinite((g as Gps).lon)
  && Math.abs((g as Gps).lat) <= 90 && Math.abs((g as Gps).lon) <= 180;

/** What the date and place were before they were changed, as written by any device; undefined when none. */
export function normOrig(o: unknown): Orig | undefined {
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  const out: Orig = {};
  if (typeof r.capture_ts === "number" && Number.isFinite(r.capture_ts)) out.capture_ts = Math.round(r.capture_ts);
  if (r.gps === null) out.gps = null;
  else if (validGps(r.gps)) out.gps = { lat: r.gps.lat, lon: r.gps.lon };
  return "capture_ts" in out || "gps" in out ? out : undefined;
}

/** The person changed the place themselves (set, moved or removed it): nothing may add one on its own any more. */
export const placeChanged = (m: Pick<EditableMeta, "orig"> | undefined) => !!m && !!normOrig(m.orig) && "gps" in normOrig(m.orig)!;

/** Anything changed: the picture, the date or the place. */
export const isEdited = (m: Pick<EditableMeta, "edit" | "orig"> | undefined) => !!m && (!!normEdit(m.edit) || !!normOrig(m.orig));

/** The key thumbnails and previews are cached under: it changes whenever new ones are made for an edit. */
export function pictureKey(id: string, m: Pick<EditableMeta, "edit"> | undefined): string {
  const v = normEdit(m?.edit)?.v;
  return v ? `${id}.${v}` : id;
}

const sameGps = (a: Gps | null | undefined, b: Gps | null | undefined) => (!a && !b) || (!!a && !!b && a.lat === b.lat && a.lon === b.lon);

function tidy<M extends EditableMeta>(m: M): M {
  const o = normOrig(m.orig);
  if (o && "capture_ts" in o && o.capture_ts === m.capture_ts) delete o.capture_ts;
  if (o && "gps" in o && sameGps(o.gps, m.gps)) delete o.gps;
  if (o && ("capture_ts" in o || "gps" in o)) m.orig = o; else delete m.orig;
  return m;
}

/** A copy of the metadata with a new capture time (ms); the first change keeps the original. */
export function withDate<M extends EditableMeta>(meta: M, ts: number): M {
  if (!Number.isFinite(ts)) throw new Error("not a date");
  const m = { ...meta, orig: { ...normOrig(meta.orig) } };
  if (!("capture_ts" in m.orig)) m.orig.capture_ts = meta.capture_ts;
  m.capture_ts = Math.round(ts);
  return tidy(m);
}

/** A copy with a new place, or none (null); the first change keeps the original (null if there was none). */
export function withPlace<M extends EditableMeta>(meta: M, gps: Gps | null): M {
  if (gps && !validGps(gps)) throw new Error("not a place");
  const m = { ...meta, orig: { ...normOrig(meta.orig) } };
  if (!("gps" in m.orig)) m.orig.gps = validGps(meta.gps) ? { lat: meta.gps.lat, lon: meta.gps.lon } : null;
  if (gps) m.gps = { lat: gps.lat, lon: gps.lon };
  else delete m.gps;
  return tidy(m);
}

/** A copy with the picture turned and cropped so (undefined: as taken); v names the thumbnail and preview made for it. */
export function withPicture<M extends EditableMeta>(meta: M, e: Edit | undefined, v: string): M {
  const m = { ...meta };
  const n = normEdit(e);
  if (n) m.edit = { ...(n.rot ? { rot: n.rot } : {}), ...(n.crop ? { crop: n.crop } : {}), v };
  else delete m.edit;
  return m;
}

/** A copy with everything as it was: the original date and place, the picture as taken. */
export function reverted<M extends EditableMeta>(meta: M): M {
  const m = { ...meta };
  const o = normOrig(meta.orig);
  if (o && "capture_ts" in o) m.capture_ts = o.capture_ts!;
  if (o && "gps" in o) { if (o.gps) m.gps = o.gps; else delete m.gps; }
  delete m.orig;
  delete m.edit;
  return m;
}

/** A short name for a new version of the thumbnail and preview, from random bytes (crypto.getRandomValues on the web,
 *  libsodium's randombytes_buf in the app). */
export const versionName = (random: Uint8Array): string => Array.from(random.subarray(0, 6), (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 12);

/** The file name of an edited copy: "beach.heic" is "beach (edited).jpg". */
export const editedName = (name: string): string => `${name.replace(/\.[^./\\]{1,8}$/, "") || "photo"} (edited).jpg`;
