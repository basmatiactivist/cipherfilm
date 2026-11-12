// @ts-nocheck (exifr's full build has loose types; vitest only)
import { describe, expect, it } from "vitest";
import exifr from "exifr/dist/full.esm.mjs";
import { exifDate, jpegOrientation, retagJpeg, withExif } from "./exif";

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

describe("a JPEG whose date or place changed, with its own pixels", () => {
  const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  // a camera's photo: its own Exif (place, date, orientation 6), XMP with a place, an ICC profile, a comment, IPTC,
  // then a scan with stuffed bytes and a restart marker, and a motion photo's video after the end
  const camera = (() => {
    const exif = withExif(jpeg(jfif), { ts: Date.UTC(2019, 0, 1), gps: { lat: 46.5, lon: 7.5 } });
    // its orientation, set to 6 (turned): the Exif block's IFD0 first entry is the orientation
    const at = [...exif.keys()].find((i) => [0x01, 0x12, 0, 3, 0, 0, 0, 1].every((b, k) => exif[i + k] === b))!;
    exif[at + 9] = 6;
    const head = [...exif.subarray(0, exif.length - scan.length)];
    return new Uint8Array([
      ...head,
      ...seg(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta exif:GPSLatitude='46,30N'/>")]),
      ...seg(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, 9, 9]),
      ...seg(0xfe, ascii("taken at home")),
      ...seg(0xed, [...ascii("Photoshop 3.0"), 0, 1, 2]),
      ...seg(0xdb, [0, 1, 2, 3]),
      0xff, 0xda, 0, 4, 1, 2, 0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9,
      ...ascii("ftypmp42 moov ©xyz+46.5+7.5/"),
    ]);
  })();

  it("keeps the picture and its orientation, and writes the place and date as set", async () => {
    expect(jpegOrientation(camera)).toBe(6);
    const ts = Date.UTC(2021, 5, 2, 10);
    const out = retagJpeg(camera, { ts, gps: { lat: -33.8688, lon: 151.2093 } });
    const x = await exifr.parse(out, { pick: ["DateTimeOriginal", "Orientation"], translateValues: false });
    expect((x.DateTimeOriginal as Date).getTime()).toBe(ts);
    expect(x.Orientation).toBe(6);
    expect((await exifr.gps(out as any)).latitude).toBeCloseTo(-33.8688, 5);
    const tail = [0xff, 0xda, 0, 4, 1, 2, 0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9];
    expect([...out.subarray(out.length - tail.length)]).toEqual(tail); // the scan as it was, nothing after its end
  });

  it("a removed place is nowhere in the copy: not in Exif, XMP, comments or a video after the picture", async () => {
    const out = retagJpeg(camera, { ts: Date.UTC(2019, 0, 1) });
    expect((await exifr.gps(out as any))?.latitude).toBeUndefined();
    const text = String.fromCharCode(...out);
    for (const s of ["GPSLatitude", "xap", "taken at home", "Photoshop", "moov", "46.5"]) expect(text).not.toContain(s);
    expect(text).toContain("ICC_PROFILE"); // the colours stay
    expect([...out.keys()].filter((i) => out[i] === 0xff && out[i + 1] === 0xe1)).toHaveLength(1);
  });

  it("refuses what it can't read as a JPEG", () => {
    expect(() => retagJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {})).toThrow();
    expect(() => retagJpeg(camera.subarray(0, 60), {})).toThrow(); // cut short
    expect(jpegOrientation(jpeg(jfif))).toBe(1);
  });
});
