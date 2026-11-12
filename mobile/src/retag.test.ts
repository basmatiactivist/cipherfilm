import { describe, expect, it, vi } from "vitest";
import { withExif } from "@edit/exif";

// A photo whose place was removed (not turned or cropped) leaves the app as its own JPEG with the metadata as set: the
// original's place is in no part of the shared file. The download and the phone's storage are stand-ins.
vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: { JPEG: "jpeg" } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("./api", () => ({ api: async () => ({}), putBytes: async () => {}, ApiError: class extends Error {} }));
vi.mock("./session", () => ({ session: () => ({ me: {} }), onWipe: () => {} }));
vi.mock("./library", () => ({ forgetPictures: () => {} }));
vi.mock("./upload", () => ({ THUMB_PX: 640, PREVIEW_PX: 2048 }));
const written = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
const original = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
vi.mock("./outbox", () => ({
  OUT: () => ({}), safeName: (n: string) => n, sweepLater: () => {},
  decryptTo: async () => ({ name: "a.jpg", bytes: async () => original.bytes.slice(), write: (b: Uint8Array) => { written.bytes = b.slice(); }, delete: () => {} }),
}));

describe("retaggedCopyTo", () => {
  it("writes the photo back without its removed place", async () => {
    const scan = [0xff, 0xda, 0, 4, 1, 2, 3, 4, 5, 0xff, 0xd9];
    const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    original.bytes = withExif(new Uint8Array([0xff, 0xd8, ...jfif, ...scan]), { ts: 1, gps: { lat: 46.5, lon: 7.5 } });
    const { retaggedCopyTo } = await import("./edit");
    const f = await retaggedCopyTo({} as never, { id: "x", kind: "image", meta: { name: "a.jpg", capture_ts: 1000, orig: { gps: { lat: 46.5, lon: 7.5 } } } } as never, new Set(), () => {});
    expect(f.name).toBe("a.jpg");
    const out = written.bytes!;
    // no GPS IFD pointer (0x8825) in the copy, and the scan unchanged
    expect([...out.keys()].some((i) => out[i] === 0x88 && out[i + 1] === 0x25)).toBe(false);
    expect([...out.subarray(out.length - scan.length)]).toEqual(scan);
    expect([...original.bytes.keys()].some((i) => original.bytes[i] === 0x88 && original.bytes[i + 1] === 0x25)).toBe(true);
  });
});
