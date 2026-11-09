// Where a video was filmed, from an MP4 or QuickTime (.mov) file (docs/MAP.md). Phones write it in one of two places:
// moov/udta/©xyz (Android, most cameras) or moov/meta keys + ilst under com.apple.quicktime.location.ISO6709 (iPhone),
// both as an ISO 6709 string ("+47.3769+008.5417+408.000/"). The moov box is at the start or at the end of the file;
// only the box headers on the way to it and the moov box itself are read, never the video data.

/** Bytes [offset, offset+length) of the file; fewer only at its end. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

const MAX_MOOV = 32 * 1024 * 1024; // a moov box that large is not a phone's video: not read
const MAX_BOXES = 10_000;

const type = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

/** "+47.3769+008.5417/" and the like: latitude and longitude in degrees; none for 0,0, out of range or anything else. */
export function parseIso6709(v: string): { lat: number; lon: number } | null {
  const m = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(v.trim());
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

interface Box { type: string; start: number; end: number } // start: first byte after the header

/** The boxes in b[from, to). */
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to && out.length < MAX_BOXES) {
    let size = u32(b, o), head = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type: type(b, o + 4), start: o + head, end: o + size });
    o += size;
  }
  return out;
}

const text = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);

/** The location in a meta box (keys + ilst), from QuickTime (no version and flags, starts with hdlr) or ISO style. */
function inMeta(b: Uint8Array, box: Box): { lat: number; lon: number } | null {
  const start = type(b, box.start + 4) === "hdlr" ? box.start : box.start + 4;
  const parts = children(b, start, box.end);
  const keys: string[] = [];
  const k = parts.find((p) => p.type === "keys");
  if (k && k.end - k.start >= 8) {
    const count = u32(b, k.start + 4);
    let o = k.start + 8;
    for (let i = 0; i < count && o + 8 <= k.end; i++) {
      const size = u32(b, o);
      if (size < 8 || o + size > k.end) break;
      keys.push(text(b.subarray(o + 8, o + size)));
      o += size;
    }
  }
  const ilst = parts.find((p) => p.type === "ilst");
  if (!ilst) return null;
  for (const entry of children(b, ilst.start, ilst.end)) {
    const t = entry.type; // the entry's type is its 1-based number in keys, as 4 bytes
    const index = ((t.charCodeAt(0) << 24) >>> 0) + (t.charCodeAt(1) << 16) + (t.charCodeAt(2) << 8) + t.charCodeAt(3);
    if (keys[index - 1] !== "com.apple.quicktime.location.ISO6709") continue;
    for (const d of children(b, entry.start, entry.end)) {
      if (d.type === "data" && d.end - d.start > 8) {
        const g = parseIso6709(text(b.subarray(d.start + 8, d.end)));
        if (g) return g;
      }
    }
  }
  return null;
}

/** The location inside a moov box's bytes: udta/©xyz, or a meta box in moov (iPhone) or in udta (other tools). */
export function locationInMoov(moov: Uint8Array): { lat: number; lon: number } | null {
  for (const box of children(moov, 0, moov.length)) {
    if (box.type === "udta") {
      for (const c of children(moov, box.start, box.end)) {
        // ©xyz: a 2-byte length and a 2-byte language, then the string
        if (c.type === "\u00a9xyz" && c.end - c.start >= 4) {
          const n = (moov[c.start] << 8) | moov[c.start + 1];
          const g = parseIso6709(text(moov.subarray(c.start + 4, Math.min(c.end, c.start + 4 + n))));
          if (g) return g;
        }
        if (c.type === "meta") {
          const g = inMeta(moov, c);
          if (g) return g;
        }
      }
    }
    if (box.type === "meta") {
      const g = inMeta(moov, box);
      if (g) return g;
    }
  }
  return null;
}

/** The location of an MP4 or QuickTime video of `size` bytes, read through `read`; null when it has none. */
export async function videoLocation(size: number, read: ReadAt): Promise<{ lat: number; lon: number } | null> {
  let o = 0;
  for (let n = 0; o + 8 <= size && n < MAX_BOXES; n++) {
    const h = await read(o, 16);
    if (h.length < 8) return null;
    let len = u32(h, 0), head = 8;
    if (len === 1) {
      if (h.length < 16) return null;
      len = u32(h, 8) * 2 ** 32 + u32(h, 12);
      head = 16;
    } else if (len === 0) len = size - o;
    if (len < head || o + len > size) return null;
    if (type(h, 4) === "moov") {
      if (len - head > MAX_MOOV) return null;
      const moov = await read(o + head, len - head);
      return moov.length === len - head ? locationInMoov(moov) : null;
    }
    o += len;
  }
  return null;
}

/** For an upload: the location of a video file. */
export const fileVideoLocation = (f: Blob) =>
  videoLocation(f.size, async (offset, length) => new Uint8Array(await f.slice(offset, offset + length).arrayBuffer())).catch(() => null);
