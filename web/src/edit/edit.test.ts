import { describe, expect, it } from "vitest";
import {
  dragCrop, drawPlan, isEdited, MIN_CROP, normEdit, normOrig, normRect, normTurn, pictureKey, placeChanged, ratioRect, reverted,
  editedName, editedSize, rotateRect, sameEdit, sourceRect, turn, turnedSize, versionName, withDate, withPicture, withPlace, type EditableMeta, type Rect,
} from "./edit";

const bare = (capture_ts: number): EditableMeta => ({ capture_ts });
const close = (a: Rect, b: Rect) => { for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 3); };

describe("checking what other devices wrote", () => {
  it("takes quarter turns only", () => {
    expect([0, 90, 180, 270, 360, -90, 450, "90", 45, NaN, null, "x"].map(normTurn)).toEqual([0, 90, 180, 270, 0, 270, 90, 90, 0, 0, 0, 0]);
  });
  it("keeps crops inside the picture and not too small", () => {
    expect(normRect({ x: -0.5, y: 0.2, w: 1, h: 0.5 })).toEqual({ x: 0, y: 0.2, w: 0.5, h: 0.5 });
    expect(normRect({ x: 0.99, y: 0.5, w: 0.001, h: 0.2 })!.w).toBeCloseTo(MIN_CROP);
    expect(normRect({ x: 0.99, y: 0.5, w: 0.001, h: 0.2 })!.x + normRect({ x: 0.99, y: 0.5, w: 0.001, h: 0.2 })!.w).toBeLessThanOrEqual(1);
    expect(normRect({ x: 0, y: 0, w: 1, h: 1 })).toBeUndefined();
    expect(normRect({ x: "0", y: 0, w: 1, h: 1 })).toBeUndefined();
    expect(normRect({ x: 0.1, y: 0.1, w: Infinity, h: 0.5 })).toBeUndefined();
    expect(normRect(null)).toBeUndefined();
    expect(normRect({ x: 0.123456, y: 0, w: 0.5, h: 0.5 })!.x).toBe(0.1235);
  });
  it("drops edits that change nothing, and anything that isn't one", () => {
    expect(normEdit({ rot: 0 })).toBeUndefined();
    expect(normEdit({ rot: 360, crop: { x: 0, y: 0, w: 1, h: 1 } })).toBeUndefined();
    expect(normEdit("rotate")).toBeUndefined();
    expect(normEdit([90])).toBeUndefined();
    expect(normEdit({ rot: 90, v: "abc123" })).toEqual({ rot: 90, v: "abc123" });
    expect(normEdit({ rot: 90, v: "../x" })).toEqual({ rot: 90 }); // the version goes into cache file names
    expect(normEdit({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, extra: 1 })).toEqual({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
  });
  it("compares edits by what they do, not their version", () => {
    expect(sameEdit({ rot: 90, v: "a" }, { rot: 90, v: "b" })).toBe(true);
    expect(sameEdit(undefined, { rot: 0 })).toBe(true);
    expect(sameEdit({ rot: 90 }, { rot: 270 })).toBe(false);
    expect(sameEdit({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }, undefined)).toBe(false);
  });
});

describe("turning and cropping", () => {
  it("moves a rectangle with the picture when it turns clockwise", () => {
    const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    close(rotateRect(r, 90), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
    close(rotateRect(r, 180), { x: 0.6, y: 0.4, w: 0.3, h: 0.4 });
    close(rotateRect(r, 270), { x: 0.2, y: 0.6, w: 0.4, h: 0.3 });
    close(rotateRect(rotateRect(r, 90), 270), r);
    close(rotateRect(r, 0), r);
  });
  it("knows the edited picture's size, for the grid", () => {
    expect(editedSize(4000, 3000, { rot: 90 })).toEqual({ w: 3000, h: 4000 });
    expect(editedSize(4000, 3000, { rot: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } })).toEqual({ w: 1500, h: 4000 });
    expect(editedSize(4000, 3000, undefined)).toEqual({ w: 4000, h: 3000 });
  });
  it("swaps width and height for a quarter turn", () => {
    expect(turnedSize(4000, 3000, 90)).toEqual({ w: 3000, h: 4000 });
    expect(turnedSize(4000, 3000, 180)).toEqual({ w: 4000, h: 3000 });
    expect(turnedSize(4000, 3000, undefined)).toEqual({ w: 4000, h: 3000 });
  });
  it("finds the crop in the original picture", () => {
    // the left half of a picture turned clockwise is the bottom half of the original
    close(sourceRect({ rot: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), { x: 0, y: 0.5, w: 1, h: 0.5 });
    close(sourceRect({ rot: 270, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), { x: 0, y: 0, w: 1, h: 0.5 });
    close(sourceRect(undefined), { x: 0, y: 0, w: 1, h: 1 });
  });
  it("keeps the same part cropped when turned again", () => {
    const e = { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }; // the top-left quarter
    const t = turn(e, 90)!;
    expect(t.rot).toBe(90);
    close(t.crop!, { x: 0.5, y: 0, w: 0.5, h: 0.5 }); // now top right
    close(sourceRect(t), sourceRect(e));
    expect(turn({ rot: 270 }, 90)).toBeUndefined(); // all the way round: nothing left to do
    close(sourceRect(turn(turn(t, 90), 90)!), sourceRect(e));
  });
  it("plans the drawing in pixels", () => {
    const p = drawPlan(4000, 3000, { rot: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } }, 1000);
    expect(p).toMatchObject({ sx: 0, sy: 1500, sw: 4000, sh: 1500, rot: 90 });
    expect(Math.max(p.outW, p.outH)).toBe(1000);
    expect(p.outW).toBe(p.dh);
    expect(p.outH).toBe(p.dw);
    expect(drawPlan(10, 10, undefined)).toMatchObject({ sx: 0, sy: 0, sw: 10, sh: 10, outW: 10, outH: 10 });
    // never larger than it is
    expect(drawPlan(400, 300, undefined, 1000)).toMatchObject({ outW: 400, outH: 300 });
  });
});

describe("crop shapes", () => {
  it("is the largest of that shape, centred", () => {
    // 1:1 in a 4000×3000 picture: 3000×3000
    close(ratioRect(1, 4000, 3000), { x: 0.125, y: 0, w: 0.75, h: 1 });
    // 16:9 in a 3000×4000 one: full width
    const r = ratioRect(16 / 9, 3000, 4000);
    expect(r.w).toBe(1);
    expect((r.w * 3000) / (r.h * 4000)).toBeCloseTo(16 / 9, 2);
    expect(ratioRect(null, 1, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("stays where the old crop was, inside the picture", () => {
    const r = ratioRect(1, 4000, 3000, { x: 0.8, y: 0, w: 0.2, h: 1 });
    expect(r.x + r.w).toBeCloseTo(1);
  });
});

describe("dragging the crop frame", () => {
  const start = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  it("moves an edge or corner freely, inside the picture", () => {
    close(dragCrop(start, "e", 0.1, 0, null, 1), { x: 0.2, y: 0.2, w: 0.7, h: 0.6 });
    close(dragCrop(start, "nw", -0.5, -0.5, null, 1), { x: 0, y: 0, w: 0.8, h: 0.8 });
    expect(dragCrop(start, "w", 0.9, 0, null, 1).w).toBeCloseTo(MIN_CROP);
  });
  it("moves the whole frame without leaving the picture", () => {
    close(dragCrop(start, "move", 0.5, -0.5, null, 1), { x: 0.4, y: 0, w: 0.6, h: 0.6 });
  });
  it("keeps the shape", () => {
    const aspect = 4000 / 3000;
    const r = dragCrop({ x: 0.1, y: 0.1, w: 0.375, h: 0.5 }, "se", 0.3, 0.05, 1, aspect); // a square in pixels
    expect((r.w * 4000) / (r.h * 3000)).toBeCloseTo(1, 2);
    expect(r.x).toBeCloseTo(0.1);
    expect(r.y).toBeCloseTo(0.1);
    expect(r.x + r.w).toBeLessThanOrEqual(1.0001);
    expect(r.y + r.h).toBeLessThanOrEqual(1.0001);
    const edge = dragCrop({ x: 0.3, y: 0.3, w: 0.3, h: 0.4 }, "n", 0, -0.9, 1, aspect);
    expect((edge.w * 4000) / (edge.h * 3000)).toBeCloseTo(1, 2);
    expect(edge.y + edge.h).toBeCloseTo(0.7); // the bottom stayed
    expect(edge.y).toBeGreaterThanOrEqual(0);
  });
});

describe("date and place", () => {
  const base: EditableMeta & { name: string } = { name: "a.jpg", capture_ts: 1000, gps: { lat: 47.37, lon: 8.54 } };
  it("keeps the originals at the first change, and only then", () => {
    const a = withDate(base, 5000.4);
    expect(a.capture_ts).toBe(5000);
    expect(a.orig).toEqual({ capture_ts: 1000 });
    const b = withDate(a, 9000);
    expect(b.orig).toEqual({ capture_ts: 1000 });
    expect(withDate(b, 1000).orig).toBeUndefined(); // back where it was: nothing to remember
    expect(base).not.toHaveProperty("orig"); // copies, never changed in place
  });
  it("sets, moves and removes the place", () => {
    const moved = withPlace(base, { lat: 48.8566, lon: 2.3522 });
    expect(moved.gps).toEqual({ lat: 48.8566, lon: 2.3522 });
    expect(moved.orig).toEqual({ gps: { lat: 47.37, lon: 8.54 } });
    const gone = withPlace(moved, null);
    expect(gone).not.toHaveProperty("gps");
    expect(placeChanged(gone)).toBe(true);
    const none = withPlace(bare(1), { lat: 1, lon: 2 });
    expect(none.orig).toEqual({ gps: null });
    expect(() => withPlace(base, { lat: 91, lon: 0 })).toThrow();
  });
  it("reverts everything", () => {
    let m = withPicture(withPlace(withDate(base, 7), null), { rot: 90 }, "v1");
    expect(isEdited(m)).toBe(true);
    m = reverted(m);
    expect(m).toEqual(base);
    expect(isEdited(m)).toBe(false);
    const none = reverted(withPlace(bare(1), { lat: 1, lon: 2 }));
    expect(none).toEqual({ capture_ts: 1 });
  });
  it("ignores originals that aren't", () => {
    expect(normOrig({ capture_ts: "x", gps: { lat: 200, lon: 0 } })).toBeUndefined();
    expect(normOrig({ gps: null })).toEqual({ gps: null });
    expect(placeChanged({ orig: { capture_ts: 3 } })).toBe(false);
  });
});

describe("the picture version", () => {
  it("names the cache entries", () => {
    expect(pictureKey("ab", undefined)).toBe("ab");
    expect(pictureKey("ab", { edit: { rot: 90, v: "x1" } })).toBe("ab.x1");
    expect(pictureKey("ab", { edit: { rot: 0, v: "x1" } })).toBe("ab"); // no edit: the original's
  });
  it("is stored with the edit, or dropped with it", () => {
    expect(withPicture(bare(1), { rot: 180 }, "v").edit).toEqual({ rot: 180, v: "v" });
    expect(withPicture({ ...bare(1), edit: { rot: 90 } }, { rot: 0 }, "v")).not.toHaveProperty("edit");
  });
  it("is short and safe for file names", () => {
    const v = versionName(new Uint8Array([0, 255, 35, 36, 200, 7, 9]));
    expect(v).toMatch(/^[0-9a-z]{1,12}$/);
    expect(normEdit({ rot: 90, v })?.v).toBe(v);
  });
});

describe("the edited copy's name", () => {
  it("is a JPEG next to the original's name", () => {
    expect(editedName("beach.heic")).toBe("beach (edited).jpg");
    expect(editedName("IMG_1.JPG")).toBe("IMG_1 (edited).jpg");
    expect(editedName("no extension")).toBe("no extension (edited).jpg");
    expect(editedName(".jpg")).toBe("photo (edited).jpg");
  });
});
