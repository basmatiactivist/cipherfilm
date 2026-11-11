// @ts-nocheck (exifr's full build has loose types; vitest only)
import { describe, expect, it } from "vitest";
import exifr from "exifr/dist/full.esm.mjs";
import { exifDate, withExif } from "./exif";

// a JPEG as a canvas makes it: SOI, a JFIF APP0, then (here, a stand-in for) the image data
const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
const scan = [0xff, 0xda, 0, 4, 1, 2, 3, 4, 5, 0xff, 0xd9];
const jpeg = (...segs: number[][]) => new Uint8Array([0xff, 0xd8, ...segs.flat(), ...scan]);

describe("EXIF for an edited copy", () => {
  it("writes the date and place so a photo app reads them", async () => {
    const ts = new Date(2024, 4, 1, 14, 3, 9).getTime();
    const out = withExif(jpeg(jfif), { ts, gps: { lat: -33.8688, lon: 151.2093 } });
    // as the apps read it at upload (media.ts readMeta)
    const x = await exifr.parse(out, { pick: ["DateTimeOriginal", "Orientation"], translateValues: false });
    expect((x.DateTimeOriginal as Date).getTime()).toBe(ts);
    expect(x.Orientation).toBe(1);
    const g = await exifr.gps(out as any);
    expect(g.latitude).toBeCloseTo(-33.8688, 5);
    expect(g.longitude).toBeCloseTo(151.2093, 5);
    expect(exifDate(ts)).toBe("2024:05:01 14:03:09");
  });
  it("writes only what there is", async () => {
    const out = withExif(jpeg(jfif), { ts: Date.UTC(2020, 0, 1) });
    const x = await exifr.parse(out);
    expect(x.DateTimeOriginal).toBeInstanceOf(Date);
    expect((await exifr.gps(out as any))?.latitude).toBeUndefined();
    expect((await exifr.gps(withExif(jpeg(jfif), {}) as any))?.latitude).toBeUndefined();
  });
  it("replaces an old EXIF block and keeps the image data", () => {
    const old = withExif(jpeg(jfif), { ts: 0 });
    const out = withExif(old, { ts: 1e12 });
    const exifs = [...out.keys()].filter((i) => out[i] === 0xff && out[i + 1] === 0xe1);
    expect(exifs).toHaveLength(1);
    expect([...out.subarray(out.length - scan.length)]).toEqual(scan);
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });
  it("refuses what isn't a JPEG", () => {
    expect(() => withExif(new Uint8Array([0x89, 0x50]), {})).toThrow();
  });
});
