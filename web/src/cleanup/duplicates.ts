// Duplicates and similar photos, found on the device (web and Android share this file, as @cleanup/duplicates).
// Nothing here talks to the server or reads a photo: it groups what the caller already has decrypted (the items'
// metadata) and asks the caller for the similarity of pairs of image vectors (the search index, docs/SEARCH.md).
//
// - Exact duplicates: the same file name, size and capture time. The metadata carries no content hash, so this is
//   the strongest signal there is; all three equal is the same file uploaded twice.
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
}

export interface Group {
  kind: "exact" | "similar";
  /** the suggested one to keep first, then the others (best first) */
  ids: string[];
  /** the suggested one to keep: ids[0] */
  keep: string;
}

export const SIMILAR = {
  /** cosine of two image vectors (MobileCLIP S2 or LAION B/32, L2-normalised) from which they count as the same scene */
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

/** The same file more than once: equal name (ignoring case), size and capture time. Groups ordered by capture time,
 *  newest first, like the timeline. */
export function exactGroups(items: Candidate[]): Group[] {
  const by = new Map<string, Candidate[]>();
  for (const c of items) {
    if (!(c.size > 0) || !Number.isFinite(c.ts)) continue;
    const k = `${c.name.toLowerCase()}\0${c.size}\0${c.ts}`;
    const list = by.get(k);
    if (list) list.push(c); else by.set(k, [c]);
  }
  const out: { ts: number; g: Group }[] = [];
  for (const list of by.values()) if (list.length > 1) out.push({ ts: list[0].ts, g: groupOf("exact", list) });
  return out.sort((a, b) => b.ts - a.ts).map((x) => x.g);
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
  /** photos (not in an exact group's extra copies) that could be compared, and how many of them have a vector */
  images: number;
  indexed: number;
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
  if (!score || usable.length < 2) return { exact, similar: [], images: photos.length, indexed: usable.length };
  const pairs = candidatePairs(usable, o.windowMs, o.neighbours);
  const scores = new Float32Array(pairs.a.length);
  for (let k = 0; k < pairs.a.length; k += SCORE_BATCH) {
    const end = Math.min(pairs.a.length, k + SCORE_BATCH);
    const a: string[] = [], b: string[] = [];
    for (let x = k; x < end; x++) { a.push(usable[pairs.a[x]].id); b.push(usable[pairs.b[x]].id); }
    const s = await score(a, b);
    for (let x = k; x < end; x++) { const v = s[x - k]; scores[x] = typeof v === "number" && Number.isFinite(v) ? v : NaN; }
  }
  return { exact, similar: similarGroupsFrom(usable, pairs, scores, o.threshold), images: photos.length, indexed: usable.length };
}

/** The ones a group suggests moving to the trash: all but the one to keep. */
export const suggested = (groups: Group[]): Set<string> => new Set(groups.flatMap((g) => g.ids.slice(1)));

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
