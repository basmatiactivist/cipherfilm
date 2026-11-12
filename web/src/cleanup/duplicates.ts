// Duplicates and similar photos, found on the device (web and Android share this file, as @cleanup/duplicates).
// Nothing here talks to the server or reads a photo: it groups what the caller already has decrypted (the items'
// metadata) and asks the caller for the similarity of pairs of image vectors (the search index, docs/SEARCH.md).
//
// - Exact duplicates: the same file. Newer uploads carry the original's SHA-256 in their metadata (docs/CRYPTO.md):
//   equal hashes are the same file, whatever it is called. Older items have none; for them the same size in bytes
//   and the same capture time (to the millisecond) count, whatever the name ("IMG_1.jpg" and "IMG_1 (1).jpg", or the
//   same photo from two devices), as long as the pixel size agrees where both know it; the same name, size and
//   capture time count as before. Two items whose hashes differ are never the same file.
// - Similar photos: images whose vectors are very close (cosine ≥ threshold) and that were taken close in time
//   (burst shots, a near-identical series). Every photo in a group is close to every other one (complete linkage),
//   so a long slow series is never chained into one big group, and a group spans at most the time window.
//   Only pairs within the window are ever compared (time-sorted sliding window, a few neighbours each), so a library
//   of tens of thousands costs a few hundred thousand comparisons at most, never n².

/** What the grouping needs of an item: from its decrypted metadata. */
export interface Candidate {
  id: string;
  /** capture time, ms since epoch */
  ts: number;
  name: string;
  /** bytes */
  size: number;
  width?: number;
  height?: number;
  /** has a location */
  gps: boolean;
  /** upload time, seconds since epoch (the server's created_at) */
  uploaded: number;
  /** a photo: only photos are compared by what they show */
  image: boolean;
  /** SHA-256 of the original, lowercase hex, where the uploading app wrote one */
  sha256?: string;
}

export interface Group {
  kind: "exact" | "similar";
  /** the suggested one to keep first, then the others (best first) */
  ids: string[];
  /** the suggested one to keep: ids[0] */
  keep: string;
}

export const SIMILAR = {
  /** cosine of two image vectors (LAION B/32, L2-normalised) from which they count as the same scene */
  threshold: 0.92,
  /** taken at most this far apart (ms) */
  windowMs: 5 * 60_000,
  /** each photo is compared with at most this many photos taken after it within the window */
  neighbours: 24,
};

/** The pairs are scored this many at a time (one message to the worker, one call into the native index). */
export const SCORE_BATCH = 4096;

const pixels = (c: Candidate) => (c.width && c.height && c.width > 0 && c.height > 0 ? c.width * c.height : 0);

/** Which to keep, best first: the highest resolution, then the largest file, then one with a location, then the
 *  earliest upload; the id last, so the choice is the same on every device. */
export function keepOrder(a: Candidate, b: Candidate): number {
  return pixels(b) - pixels(a) || b.size - a.size || Number(b.gps) - Number(a.gps) || a.uploaded - b.uploaded || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const groupOf = (kind: Group["kind"], members: Candidate[]): Group => {
  const ids = [...members].sort(keepOrder).map((c) => c.id);
  return { kind, ids, keep: ids[0] };
};

const SHA = /^[0-9a-f]{64}$/;
const hashOf = (c: Candidate) => (c.sha256 && SHA.test(c.sha256) ? c.sha256 : undefined);

/** The pixel size agrees, either way round (a client may report it before or after the EXIF turn), or one doesn't
 *  know it. */
const sameShape = (a: Candidate, b: Candidate) => {
  if (!pixels(a) || !pixels(b)) return true;
  return (a.width === b.width && a.height === b.height) || (a.width === b.height && a.height === b.width);
};

/** Without a hash on at least one side: the same size and capture time, and the same name or a pixel size that agrees. */
const looksSame = (a: Candidate, b: Candidate) =>
  a.size === b.size && a.ts === b.ts && (a.name.toLowerCase() === b.name.toLowerCase() || sameShape(a, b));

/** The same file more than once (see the top of this file). Groups ordered by capture time, newest first, like the
 *  timeline. */
export function exactGroups(items: Candidate[]): Group[] {
  type Cluster = { members: Candidate[]; sha?: string };
  const clusters: Cluster[] = [];
  const bySha = new Map<string, Cluster>();
  const byBucket = new Map<string, Cluster[]>(); // size and capture time → the clusters with a member there
  const bucket = (c: Candidate) => `${c.size}\0${c.ts}`;
  const note = (c: Candidate, cl: Cluster) => {
    const k = bucket(c), list = byBucket.get(k);
    if (!list) byBucket.set(k, [cl]); else if (!list.includes(cl)) list.push(cl);
  };
  const usable = items.filter((c) => c.size > 0 && Number.isFinite(c.ts))
    .sort((a, b) => a.size - b.size || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // first the ones with a hash: one cluster per hash
  for (const c of usable) {
    const h = hashOf(c);
    if (!h) continue;
    let cl = bySha.get(h);
    if (!cl) { cl = { members: [], sha: h }; bySha.set(h, cl); clusters.push(cl); }
    cl.members.push(c);
    note(c, cl);
  }
  // then each one without: into the first cluster at its size and time that it fits as a whole (it looks the same as
  // one of a hash cluster's hashed members and as every member without a hash), else a cluster of its own
  for (const c of usable) {
    if (hashOf(c)) continue;
    const fits = (cl: Cluster) => {
      const plain = cl.members.filter((m) => !hashOf(m));
      if (!plain.every((m) => looksSame(c, m))) return false;
      return !cl.sha || cl.members.some((m) => hashOf(m) && looksSame(c, m));
    };
    let cl = byBucket.get(bucket(c))?.find(fits);
    if (!cl) { cl = { members: [] }; clusters.push(cl); }
    cl.members.push(c);
    note(c, cl);
  }
  return clusters.filter((cl) => cl.members.length > 1)
    .map((cl) => ({ ts: Math.max(...cl.members.map((m) => m.ts)), g: groupOf("exact", cl.members) }))
    .sort((a, b) => b.ts - a.ts || (a.g.keep < b.g.keep ? -1 : 1)).map((x) => x.g);
}

/** Pairs of positions in `sorted` (ascending by ts) taken within windowMs of each other, each item with at most
 *  `neighbours` later ones. a[k] < b[k]. */
export function candidatePairs(sorted: { ts: number }[], windowMs = SIMILAR.windowMs, neighbours = SIMILAR.neighbours): { a: Int32Array; b: Int32Array } {
  let n = 0;
  const count = (emit?: (i: number, j: number) => void) => {
    let k = 0;
    for (let i = 0; i < sorted.length; i++) {
      const end = sorted[i].ts + windowMs;
      for (let j = i + 1, m = 0; j < sorted.length && m < neighbours && sorted[j].ts <= end; j++, m++) { emit?.(i, j); k++; }
    }
    return k;
  };
  n = count();
  const a = new Int32Array(n), b = new Int32Array(n);
  let at = 0;
  count((i, j) => { a[at] = i; b[at] = j; at++; });
  return { a, b };
}

/**
 * Groups `sorted` (ascending by ts) by the scored pairs: an item joins the group (still within the window) with whose
 * every member it scores ≥ threshold, the one it is closest to on its weakest pair; otherwise it starts a group.
 * Pairs not scored (outside the window, beyond the neighbours, no vector: NaN) don't count as similar.
 */
export function similarGroupsFrom(sorted: Candidate[], pairs: { a: Int32Array; b: Int32Array }, scores: ArrayLike<number>, threshold = SIMILAR.threshold): Group[] {
  // for each item, the earlier items it is close to, with the score
  const back = new Map<number, Map<number, number>>();
  for (let k = 0; k < pairs.a.length; k++) {
    const s = scores[k];
    if (!(s >= threshold)) continue; // NaN and missing fail too
    const i = pairs.a[k], j = pairs.b[k];
    let m = back.get(j);
    if (!m) back.set(j, (m = new Map()));
    m.set(i, s);
  }
  const groupAt = new Int32Array(sorted.length).fill(-1);
  const groups: number[][] = [];
  for (let j = 0; j < sorted.length; j++) {
    const near = back.get(j);
    let best = -1, bestMin = -Infinity;
    if (near) {
      const tried = new Set<number>();
      for (const i of near.keys()) {
        const g = groupAt[i];
        if (g < 0 || tried.has(g)) continue;
        tried.add(g);
        let min = Infinity;
        for (const m of groups[g]) { const s = near.get(m); if (s === undefined) { min = -Infinity; break; } if (s < min) min = s; }
        if (min > bestMin) { bestMin = min; best = g; }
      }
    }
    if (best >= 0 && bestMin >= threshold) { groups[best].push(j); groupAt[j] = best; }
    else { groupAt[j] = groups.length; groups.push([j]); }
  }
  return groups.filter((g) => g.length > 1)
    .sort((x, y) => sorted[y[0]].ts - sorted[x[0]].ts)
    .map((g) => groupOf("similar", g.map((i) => sorted[i])));
}

export interface Found {
  exact: Group[];
  similar: Group[];
  /** photos and videos checked for exact copies */
  checked: number;
  /** photos (not in an exact group's extra copies) that could be compared, and how many of them have a vector */
  images: number;
  indexed: number;
}

/** How far the look for similar photos went, for what the screen says: search is off (nothing compared), only some
 *  photos have a vector, all of them do, or there are no photos to compare. */
export type SimilarCheck = "off" | "partial" | "complete" | "nothing";
export function similarCheck(f: Pick<Found, "images" | "indexed">, searchOn: boolean): SimilarCheck {
  if (f.images === 0) return "nothing";
  if (!searchOn) return "off";
  return f.indexed >= f.images ? "complete" : "partial";
}

/**
 * Exact duplicates first; then similar photos among the photos that have a vector, where each exact group takes part
 * only with the one it suggests to keep. score(a, b) returns the cosine for each pair of ids (NaN without a vector);
 * it is asked SCORE_BATCH pairs at a time.
 */
export async function findGroups(items: Candidate[], indexed: (id: string) => boolean, score: ((a: string[], b: string[]) => Promise<ArrayLike<number>>) | null,
  opts: Partial<typeof SIMILAR> = {}): Promise<Found> {
  const o = { ...SIMILAR, ...opts };
  const exact = exactGroups(items);
  const extra = new Set<string>();
  for (const g of exact) for (const id of g.ids.slice(1)) extra.add(id);
  const photos = items.filter((c) => c.image && !extra.has(c.id) && Number.isFinite(c.ts));
  const usable = photos.filter((c) => indexed(c.id)).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
  const checked = items.length;
  if (!score || usable.length < 2) return { exact, similar: [], checked, images: photos.length, indexed: usable.length };
  const pairs = candidatePairs(usable, o.windowMs, o.neighbours);
  const scores = new Float32Array(pairs.a.length);
  for (let k = 0; k < pairs.a.length; k += SCORE_BATCH) {
    const end = Math.min(pairs.a.length, k + SCORE_BATCH);
    const a: string[] = [], b: string[] = [];
    for (let x = k; x < end; x++) { a.push(usable[pairs.a[x]].id); b.push(usable[pairs.b[x]].id); }
    const s = await score(a, b);
    for (let x = k; x < end; x++) { const v = s[x - k]; scores[x] = typeof v === "number" && Number.isFinite(v) ? v : NaN; }
  }
  return { exact, similar: similarGroupsFrom(usable, pairs, scores, o.threshold), checked, images: photos.length, indexed: usable.length };
}

/** The ones a group suggests moving to the trash: all but the one to keep. */
export const suggested = (groups: Group[]): Set<string> => new Set(groups.flatMap((g) => g.ids.slice(1)));

/** The suggestion with the person's own changes on top (id → chosen or not), for the groups there are now. */
export function chosenWith(groups: Group[], changed: Map<string, boolean>): Set<string> {
  const out = new Set<string>();
  for (const g of groups) g.ids.forEach((id, k) => { if (changed.get(id) ?? k > 0) out.add(id); });
  return out;
}

/** Bytes the chosen ones take. */
export function bytesOf(ids: Iterable<string>, size: (id: string) => number): number {
  let n = 0;
  for (const id of ids) n += size(id) || 0;
  return n;
}

/** Cosine of two vectors (any length; 0 for a zero vector). */
export function cosine(x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (x.length !== y.length) return NaN;
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  return nx && ny ? d / Math.sqrt(nx * ny) : 0;
}

/** score() over vectors kept in memory (the web's worker; tests). */
export const scoreWith = (vector: (id: string) => ArrayLike<number> | undefined) => (a: string[], b: string[]): Float32Array => {
  const out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const x = vector(a[k]), y = vector(b[k]);
    out[k] = x && y ? cosine(x, y) : NaN;
  }
  return out;
};
