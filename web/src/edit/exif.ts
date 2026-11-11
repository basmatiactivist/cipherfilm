// A small EXIF block for an edited copy (docs/EDITING.md): the picture drawn anew has none, so the date it was taken
// and the place (if any) are written back, as the person last set them, and the orientation is "as stored" (the
// turn is already in the pixels). Shared with the Android app (@edit/exif). Nothing else of the original's EXIF is
// copied: an edited copy carries no camera serial numbers or other details nobody asked to share.

export interface ExifInfo { /** capture time, ms since epoch; written as local time, as cameras do */ ts?: number; gps?: { lat: number; lon: number } }

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, BYTE = 1;
interface Entry { tag: number; type: number; count: number; data: number[] /* bytes, big endian */ }

const u16 = (v: number) => [(v >> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0) & 127).concat(0);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2024:05:01 14:03:09" in this device's time zone. */
export function exifDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Degrees as three rationals: degrees, minutes, seconds (to 1/1000 s). */
function dms(v: number): number[] {
  const a = Math.abs(v);
  const deg = Math.floor(a), minF = (a - deg) * 60, min = Math.floor(minF), sec = Math.round((minF - min) * 60 * 1000);
  return [...u32(deg), ...u32(1), ...u32(min), ...u32(1), ...u32(sec), ...u32(1000)];
}

/** One IFD at `at` (offset from the TIFF header): its entries, then the values that don't fit in four bytes. */
function ifd(entries: Entry[], at: number): number[] {
  entries.sort((a, b) => a.tag - b.tag);
  const out: number[] = [...u16(entries.length)];
  const extra: number[] = [];
  let dataAt = at + 2 + entries.length * 12 + 4;
  for (const e of entries) {
    out.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
    if (e.data.length <= 4) out.push(...e.data, ...new Array(4 - e.data.length).fill(0));
    else {
      out.push(...u32(dataAt + extra.length));
      extra.push(...e.data);
      if (extra.length % 2) extra.push(0); // values start on even offsets
    }
  }
  out.push(...u32(0));
  return out.concat(extra);
}

/** The APP1 segment (marker included) with the date and place. */
export function exifSegment(info: ExifInfo): Uint8Array {
  const hasDate = typeof info.ts === "number" && Number.isFinite(info.ts);
  const g = info.gps && Number.isFinite(info.gps.lat) && Number.isFinite(info.gps.lon) ? info.gps : undefined;
  // IFD0 holds the orientation and points to the Exif and GPS IFDs; the sizes are known before the offsets
  const ifd0Count = 1 + (hasDate ? 1 : 0) + (g ? 1 : 0);
  const ifd0Len = 2 + ifd0Count * 12 + 4;
  const exifAt = 8 + ifd0Len;
  const exifIfd = hasDate ? ifd([{ tag: 0x9003, type: ASCII, count: 20, data: ascii(exifDate(info.ts!)) }], exifAt) : [];
  const gpsAt = exifAt + exifIfd.length;
  const gpsIfd = g ? ifd([
    { tag: 0x0000, type: BYTE, count: 4, data: [2, 3, 0, 0] },
    { tag: 0x0001, type: ASCII, count: 2, data: ascii(g.lat < 0 ? "S" : "N") },
    { tag: 0x0002, type: RATIONAL, count: 3, data: dms(g.lat) },
    { tag: 0x0003, type: ASCII, count: 2, data: ascii(g.lon < 0 ? "W" : "E") },
    { tag: 0x0004, type: RATIONAL, count: 3, data: dms(g.lon) },
  ], gpsAt) : [];
  const ifd0Entries: Entry[] = [{ tag: 0x0112, type: SHORT, count: 1, data: u16(1) }];
  if (hasDate) ifd0Entries.push({ tag: 0x8769, type: LONG, count: 1, data: u32(exifAt) });
  if (g) ifd0Entries.push({ tag: 0x8825, type: LONG, count: 1, data: u32(gpsAt) });
  const tiff = [0x4d, 0x4d, 0, 42, ...u32(8), ...ifd(ifd0Entries, 8), ...exifIfd, ...gpsIfd];
  const body = [...ascii("Exif"), 0, ...tiff]; // "Exif" NUL NUL
  return new Uint8Array([0xff, 0xe1, ...u16(body.length + 2), ...body]);
}

/** The JPEG with its own EXIF blocks (if any) replaced by one with the date and place. */
export function withExif(jpeg: Uint8Array, info: ExifInfo): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const parts: Uint8Array[] = [jpeg.subarray(0, 2), exifSegment(info)];
  let o = 2;
  // the segments before the image data: an old Exif APP1 is dropped, everything else kept
  while (o + 4 <= jpeg.length && jpeg[o] === 0xff) {
    const marker = jpeg[o + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan: the rest is image data
    const len = (jpeg[o + 2] << 8) | jpeg[o + 3];
    if (len < 2 || o + 2 + len > jpeg.length) break;
    const seg = jpeg.subarray(o, o + 2 + len);
    const isExif = marker === 0xe1 && seg[4] === 0x45 && seg[5] === 0x78 && seg[6] === 0x69 && seg[7] === 0x66;
    if (!isExif) parts.push(seg);
    o += 2 + len;
  }
  parts.push(jpeg.subarray(o));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
