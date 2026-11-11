// SHA-256 (FIPS 180-4), fed piece by piece: the browser's libsodium build has none, and WebCrypto's digest() wants the
// whole file at once. Used for the `sha256` field of an item's encrypted metadata (docs/CRYPTO.md), computed from the
// parts as they are read for encryption, so a file is never read twice for it.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private fill = 0;
  private bytes = 0;
  private done = false;

  private block(b: Uint8Array, at: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++, at += 4) w[i] = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  update(data: Uint8Array): this {
    if (this.done) throw new Error("sha256: already finished");
    let i = 0;
    this.bytes += data.length;
    if (this.fill) {
      const n = Math.min(64 - this.fill, data.length);
      this.buf.set(data.subarray(0, n), this.fill);
      this.fill += n; i = n;
      if (this.fill < 64) return this;
      this.block(this.buf, 0);
      this.fill = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.fill = data.length - i; }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error("sha256: already finished");
    const bits = this.bytes * 8;
    const tail = new Uint8Array(this.fill < 56 ? 64 : 128);
    tail.set(this.buf.subarray(0, this.fill));
    tail[this.fill] = 0x80;
    const v = new DataView(tail.buffer);
    v.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    v.setUint32(tail.length - 4, bits >>> 0);
    this.block(tail, 0);
    if (tail.length === 128) this.block(tail, 64);
    this.done = true;
    const out = new Uint8Array(32);
    const o = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) o.setUint32(i * 4, this.h[i]);
    return out;
  }

  /** The digest as 64 lowercase hex characters: the form the metadata stores. */
  hex(): string {
    return Array.from(this.digest(), (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/** A metadata `sha256` as written by the apps: 64 hex characters, lowercase. Anything else is not trusted. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;
