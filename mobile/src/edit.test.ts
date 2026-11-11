import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: { JPEG: "jpeg" } }));
vi.mock("expo-asset", () => ({ Asset: { fromModule: () => ({}) } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("./api", () => ({ api: async () => ({}), putBytes: async () => {}, ApiError: class extends Error {} }));
const who = vi.hoisted(() => ({ demo: false }));
vi.mock("./session", () => ({ session: () => ({ me: { demo: who.demo } }), onWipe: () => {} }));
vi.mock("./autolock", () => ({ away: (f: () => unknown) => f() }));
vi.mock("./library", () => ({ forgetPictures: () => {} }));
vi.mock("./upload", () => ({ THUMB_PX: 640, PREVIEW_PX: 2048 }));

const { canEdit, canEditPicture, dateParts, manipulatorSteps, parseDateTime, sourcePx, SOURCE_MAX } = await import("./edit");

describe("turning and cropping on the phone", () => {
  it("turns, then crops in the turned picture's pixels, then scales", () => {
    // a 4000×3000 photo turned clockwise is 3000×4000; its left half is 1500×4000
    expect(manipulatorSteps(4000, 3000, { rot: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } }, 2048)).toEqual({
      rotate: 90, crop: { originX: 0, originY: 0, width: 1500, height: 4000 }, resize: { width: 768, height: 2048 },
    });
    expect(manipulatorSteps(400, 300, undefined, 2048)).toEqual({ rotate: undefined, crop: undefined, resize: undefined });
    expect(manipulatorSteps(4000, 3000, { rot: 180 }, 0)).toEqual({ rotate: 180, crop: undefined, resize: undefined });
  });
  it("never crops outside the picture", () => {
    const s = manipulatorSteps(101, 101, { crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, 0);
    expect(s.crop!.originX + s.crop!.width).toBeLessThanOrEqual(101);
    expect(s.crop!.originY + s.crop!.height).toBeLessThanOrEqual(101);
  });
  it("decodes the original large enough for the crop, within bounds", () => {
    expect(sourcePx(undefined, 2048)).toBe(2048);
    expect(sourcePx({ crop: { x: 0, y: 0, w: 0.25, h: 0.5 } }, 2048)).toBe(4096);
    expect(sourcePx({ crop: { x: 0, y: 0, w: 0.02, h: 0.02 } }, 2048)).toBe(SOURCE_MAX);
  });
});

describe("the date typed in", () => {
  it("reads it in this phone's time zone, keeping the seconds", () => {
    const keep = new Date(2020, 0, 1, 0, 0, 42).getTime();
    expect(parseDateTime("2024-05-01", "14:03", keep)).toBe(new Date(2024, 4, 1, 14, 3, 42).getTime());
    expect(parseDateTime(" 2024-5-1 ", "9.05")).toBe(new Date(2024, 4, 1, 9, 5, 0).getTime());
    const p = dateParts(new Date(2024, 4, 1, 14, 3).getTime());
    expect(p).toEqual({ date: "2024-05-01", time: "14:03" });
  });
  it("refuses what isn't a date or time", () => {
    for (const [d, t] of [["2024-02-30", "10:00"], ["2024-13-01", "10:00"], ["2024-05-01", "24:00"], ["2024-05-01", "10:60"], ["yesterday", "10:00"], ["2024-05-01", ""], ["0099-01-01", "10:00"]]) {
      expect(parseDateTime(d, t)).toBeNull();
    }
  });
});

describe("what can be edited", () => {
  const item = (extra: object) => ({ id: "a", kind: "image" as const, size: 10, segment_count: 1, created_at: 1, has_thumb: true, has_preview: true, itemKey: new Uint8Array(32), meta: { name: "a.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1 }, ...extra });
  it("photos fully, videos only their date and place, nothing in the trash or unreadable", () => {
    expect(canEdit(item({})) && canEditPicture(item({}))).toBe(true);
    expect(canEdit(item({ kind: "video" }))).toBe(true);
    expect(canEditPicture(item({ kind: "video" }))).toBe(false);
    expect(canEdit(item({ trashed_at: 5 }))).toBe(false);
    expect(canEdit(item({ broken: true }))).toBe(false);
    expect(canEdit(item({ kind: "other" }))).toBe(false);
    expect(canEditPicture(item({ size: 300 * 1024 * 1024 }))).toBe(false);
  });
  it("nothing in the public demo", () => {
    who.demo = true;
    try { expect(canEdit(item({}))).toBe(false); } finally { who.demo = false; }
  });
});
