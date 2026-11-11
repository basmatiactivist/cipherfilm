// The explicit-content filter of search (docs/SEARCH.md, "Explicit content"), shared by the web and Android apps (the
// Mac has a port: mac/Sources/CipherfilmCore/Explicit.swift). Plain functions, no model run: an image vector, or a
// query's text vector, is compared with the text vectors of fixed explicit and neutral concepts made once by
// scripts/explicit-filter.py (server/explicit-filter.json, read when the app is built).
//
// It runs on the device, on vectors that are already there, when the index is read: nothing is stored or sent for
// it, so the server learns nothing, entries made before it existed are filtered too, and a later release can change
// the threshold without indexing again.
import FILTER from "../../../server/explicit-filter.json";
import { rank, type Hit } from "./rank";

export const IMAGE_THRESHOLD: number = FILTER.image.threshold;
export const QUERY_THRESHOLD: number = FILTER.query.threshold;

export { unfiltered } from "./rank"; // (there, so the main thread's bundle doesn't take the concepts along)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function unb64url(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0, n = 0, k = 0;
  for (const c of s) {
    const v = B64.indexOf(c === "+" ? "-" : c === "/" ? "_" : c);
    if (v < 0) continue;
    bits = (bits << 6) | v; n += 6;
    if (n >= 8) { n -= 8; out[k++] = (bits >> n) & 255; }
  }
  return out.subarray(0, k);
}

/** IEEE half floats (little-endian) to numbers, as the index entries store vectors. */
export function halfs(b: Uint8Array): Float32Array {
  const out = new Float32Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const h = b[2 * i] | (b[2 * i + 1] << 8);
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

interface Concept { explicit: boolean; image: boolean; v: Float32Array }
let concepts: Concept[] | null = null;
const all = () => (concepts ??= FILTER.concepts.map((c) => ({ explicit: c.explicit, image: c.image, v: unit(halfs(unb64url(c.vec))) })));

/** How much more the vector looks like the closest explicit concept than like the closest neutral one (cosine);
 *  image: only the concepts worded as captions (for an image vector), otherwise all (for search words). NaN for a
 *  vector of another length. */
export function explicitScore(v: Float32Array, image: boolean): number {
  const cs = all();
  if (!cs.length || v.length !== cs[0].v.length) return NaN;
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  let e = -Infinity, o = -Infinity;
  for (const c of cs) {
    if (image && !c.image) continue;
    let d = 0;
    for (let i = 0; i < v.length; i++) d += v[i] * c.v[i];
    d /= n;
    if (c.explicit) { if (d > e) e = d; } else if (d > o) o = d;
  }
  return e - o;
}

/** A photo kept out of filtered search results (image vector, any scale). */
export const imageHidden = (v: Float32Array) => explicitScore(v, true) >= IMAGE_THRESHOLD;
/** Search words that find nothing in filtered search (their text vector). */
export const queryBlocked = (q: Float32Array) => explicitScore(q, false) >= QUERY_THRESHOLD;

/** A search over the vectors: filtered, explicit words find nothing and explicit photos (hidden) are left out. */
export function searchHits(query: Float32Array, vectors: Map<string, Float32Array>, hidden: Set<string>, filtered: boolean): Hit[] {
  if (filtered && queryBlocked(query)) return [];
  return rank(query, vectors, filtered ? hidden : undefined);
}
