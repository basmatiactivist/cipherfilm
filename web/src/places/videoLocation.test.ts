import { describe, expect, it } from "vitest";
import { locationInMoov, parseIso6709, videoLocation } from "./videoLocation";

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const box = (t: string | Uint8Array, ...p: Uint8Array[]) => { const body = cat(...p); return cat(u32(8 + body.length), typeof t === "string" ? enc(t) : t, body); };
const bigBox = (t: string, body: Uint8Array) => cat(u32(1), enc(t), u32(0), u32(16 + body.length), body);
const utf8 = (s: string) => new TextEncoder().encode(s);

// Android and most cameras: moov/udta/©xyz
const xyz = (iso: string) => { const b = utf8(iso); return box(cat(new Uint8Array([0xa9]), enc("xyz")), new Uint8Array([b.length >> 8, b.length & 255, 0x15, 0xc7]), b); };
// iPhone: moov/meta (hdlr, keys, ilst)
const appleMeta = (iso: string) => {
  const key = (name: string) => cat(u32(8 + name.length), enc("mdta"), utf8(name));
  const keys = box("keys", u32(0), u32(2), key("com.apple.quicktime.make"), key("com.apple.quicktime.location.ISO6709"));
  const data = (v: string) => box("data", u32(1), u32(0), utf8(v));
  const ilst = box("ilst", box(u32(1), data("Apple")), box(u32(2), data(iso)));
  return box("meta", box("hdlr", u32(0), u32(0), enc("mdta"), new Uint8Array(12)), keys, ilst);
};
const file = (...p: Uint8Array[]) => cat(...p);
const reader = (b: Uint8Array) => async (o: number, n: number) => b.slice(o, o + n);
const at = (b: Uint8Array) => videoLocation(b.length, reader(b));

describe("where a video was filmed", () => {
  it("reads ISO 6709 strictly", () => {
    expect(parseIso6709("+47.3769+008.5417+408.000/")).toEqual({ lat: 47.3769, lon: 8.5417 });
    expect(parseIso6709("-33.9249+018.4241/")).toEqual({ lat: -33.9249, lon: 18.4241 });
    expect(parseIso6709("+00.0000+000.0000/")).toBeNull();
    expect(parseIso6709("+91.0+008.0/")).toBeNull();
    expect(parseIso6709("+47.0+181.0/")).toBeNull();
    expect(parseIso6709("Zurich")).toBeNull();
  });

  it("finds ©xyz with the moov box at the start or at the end", async () => {
    const moov = box("moov", box("mvhd", new Uint8Array(100)), box("udta", xyz("+48.8584+002.2945/")));
    const mdat = box("mdat", new Uint8Array(5000));
    expect(await at(file(box("ftyp", enc("isom")), moov, mdat))).toEqual({ lat: 48.8584, lon: 2.2945 });
    expect(await at(file(box("ftyp", enc("isom")), mdat, moov))).toEqual({ lat: 48.8584, lon: 2.2945 });
  });

  it("finds the iPhone's location key", async () => {
    const moov = box("moov", box("mvhd", new Uint8Array(100)), appleMeta("+51.5007-000.1246+012.000/"));
    expect(await at(file(box("ftyp", enc("qt  ")), box("wide"), box("mdat", new Uint8Array(100)), moov))).toEqual({ lat: 51.5007, lon: -0.1246 });
  });

  it("finds the location key in a meta box inside udta too (ffmpeg and other tools)", async () => {
    const moov = box("moov", box("mvhd", new Uint8Array(100)), box("udta", appleMeta("+51.5007-000.1246/")));
    expect(await at(file(box("ftyp", enc("qt  ")), box("mdat", new Uint8Array(100)), moov))).toEqual({ lat: 51.5007, lon: -0.1246 });
  });

  it("walks past boxes with 64-bit sizes", async () => {
    const moov = box("moov", box("udta", xyz("+47.0502+008.3093/")));
    expect(await at(file(box("ftyp", enc("isom")), bigBox("mdat", new Uint8Array(300)), moov))).toEqual({ lat: 47.0502, lon: 8.3093 });
  });

  it("gives nothing for a video without one, and never fails on broken files", async () => {
    expect(await at(file(box("ftyp", enc("isom")), box("moov", box("mvhd", new Uint8Array(10)))))).toBeNull();
    expect(await at(new Uint8Array(0))).toBeNull();
    expect(await at(cat(u32(4), enc("moov")))).toBeNull(); // size smaller than the header
    expect(await at(cat(u32(1000), enc("ftyp"), new Uint8Array(10)))).toBeNull(); // past the end
    expect(locationInMoov(cat(u32(1), enc("udta")))).toBeNull();
    for (let i = 0; i < 300; i++) {
      const junk = Uint8Array.from({ length: 64 + (i % 50) }, (_, j) => (i * 31 + j * 17) & 255);
      await at(junk);
      locationInMoov(junk);
    }
  });
});
