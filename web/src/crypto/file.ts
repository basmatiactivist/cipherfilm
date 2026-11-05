import type { Sodium } from "./sodium";
import { CTX, subkey } from "./kdf";

/** Files are cut into 4 MiB segments; each segment is an independent libsodium secretstream of 64 KiB chunks. */
export const SEG_PLAIN = 4 * 1024 * 1024;
export const CHUNK = 64 * 1024;
const HEADER = 24;
const ABYTES = 17;

export const segmentCount = (total: number): number => Math.max(1, Math.ceil(total / SEG_PLAIN));

/** Plaintext length of segment i of a file with the given total size. */
export const segmentPlainLen = (total: number, i: number): number => Math.min(SEG_PLAIN, total - i * SEG_PLAIN);

/** Ciphertext length for a plaintext segment of length p (an empty segment still has one final chunk). */
export const cipherLen = (p: number): number => HEADER + p + Math.max(1, Math.ceil(p / CHUNK)) * ABYTES;

/** Binds the item, the segment index, the segment count and the total size into every chunk's tag. */
function adFor(s: Sodium, itemId: string, i: number, count: number, total: number): Uint8Array {
  const prefix = s.from_string("seg\0" + itemId);
  const out = new Uint8Array(prefix.length + 16);
  out.set(prefix);
  const dv = new DataView(out.buffer, prefix.length);
  dv.setUint32(0, i);
  dv.setUint32(4, count);
  dv.setBigUint64(8, BigInt(total));
  return out;
}

export function encryptSegment(s: Sodium, itemKey: Uint8Array, itemId: string, i: number, count: number, total: number, plain: Uint8Array): Uint8Array {
  if (plain.length !== segmentPlainLen(total, i) && !(total === 0 && plain.length === 0)) throw new Error("unexpected segment length");
  const key = subkey(s, itemKey, CTX.itemSeg, i);
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  const ad = adFor(s, itemId, i, count, total);
  const out = new Uint8Array(cipherLen(plain.length));
  out.set(header);
  let o = HEADER;
  let off = 0;
  do {
    const chunk = plain.subarray(off, off + CHUNK);
    const last = off + CHUNK >= plain.length;
    const tag = last ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const ct = s.crypto_secretstream_xchacha20poly1305_push(state, chunk, ad, tag);
    out.set(ct, o);
    o += ct.length;
    off += CHUNK;
  } while (off < plain.length);
  s.memzero(key);
  return out;
}

export function decryptSegment(s: Sodium, itemKey: Uint8Array, itemId: string, i: number, count: number, total: number, blob: Uint8Array): Uint8Array {
  const wantPlain = total === 0 ? 0 : segmentPlainLen(total, i);
  if (i < 0 || i >= count || count !== segmentCount(total) || wantPlain < 0 || blob.length !== cipherLen(wantPlain)) throw new Error("segment failed verification");
  const key = subkey(s, itemKey, CTX.itemSeg, i);
  const out = new Uint8Array(wantPlain);
  try {
    const state = s.crypto_secretstream_xchacha20poly1305_init_pull(blob.subarray(0, HEADER), key);
    const ad = adFor(s, itemId, i, count, total);
    let o = HEADER;
    let w = 0;
    const FINAL = s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    for (;;) {
      const end = Math.min(blob.length, o + CHUNK + ABYTES);
      const r = s.crypto_secretstream_xchacha20poly1305_pull(state, blob.subarray(o, end), ad);
      if (!r) throw new Error("segment failed verification");
      out.set(r.message, w);
      w += r.message.length;
      o = end;
      if (r.tag === FINAL) break;
      if (o >= blob.length) throw new Error("segment truncated");
    }
    if (o !== blob.length || w !== wantPlain) throw new Error("segment failed verification");
    return out;
  } catch (e) {
    s.memzero(out); // whatever was opened of a segment that failed is not left behind
    throw e;
  } finally {
    s.memzero(key);
  }
}
