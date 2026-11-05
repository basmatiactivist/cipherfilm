import { SEG_PLAIN } from "./crypto/file";

export type ByteRange = { start: number; end: number }; // inclusive, like HTTP

/** Parses a single `bytes=a-b` range. null = no Range header, "invalid" = unsatisfiable or unsupported. */
export function parseRange(header: string | null, total: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "") || total <= 0) return "invalid";
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]); // suffix: last n bytes
    if (n === 0) return "invalid";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  return start > end || start >= total ? "invalid" : { start, end };
}

/** Which segments cover a byte range, and the slice to take from the first and the last. */
export function spanFor(r: ByteRange): { first: number; last: number } {
  return { first: Math.floor(r.start / SEG_PLAIN), last: Math.floor(r.end / SEG_PLAIN) };
}

/** [from, to) offsets inside plaintext segment `seg` for range r. */
export function sliceFor(seg: number, r: ByteRange, segLen: number): [number, number] {
  const base = seg * SEG_PLAIN;
  return [Math.max(0, r.start - base), Math.min(segLen, r.end - base + 1)];
}

/** The type a video is played under: always one of a few video types, whatever the stored metadata says, so the bytes
 *  can never be handed to the browser as a page or an image. */
export const playMime = (mime: string, name: string): string => {
  const n = name.toLowerCase();
  if (/^video\/(mp4|webm|ogg)$/.test(mime)) return mime;
  if (n.endsWith(".webm")) return "video/webm";
  if (n.endsWith(".ogv")) return "video/ogg";
  return "video/mp4"; // QuickTime and everything else: browsers play what they can of it as MP4
};
