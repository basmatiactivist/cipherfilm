// The faces of the search index, in memory only, and how they are grouped into people: a port of SearchIndex.cluster
// (mac/Sources/CipherfilmCore/SearchIndex.swift, SearchIndex.kt on Android), so every device shows the same groups.
// The web never computes vectors itself; it reads what the Android and Mac apps stored (docs/SEARCH.md).

export const FACE_DIM = 128;

/** Decodes float16 little-endian numbers. */
export function unhalf(b: Uint8Array): Float32Array {
  const out = new Float32Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const h = b[2 * i] | (b[2 * i + 1] << 8);
    const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    out[i] = exp === 0 ? sign * frac * 2 ** -24 : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * (1 + frac / 1024) * 2 ** (exp - 15);
  }
  return out;
}

/** False for a vector with NaN or infinite parts: such an entry would make every score with it NaN and the order of
 *  results depend on the sort, so it is left out of search and grouping. */
export const allFinite = (v: Float32Array) => v.every(Number.isFinite);

export interface FaceFound { box: number[]; score: number; emb: Uint8Array }
export interface Cover { key: string; item: string; box: number[] }
export interface FaceGroup { person?: string; faces: string[]; items: string[]; cover?: Cover }

interface FaceRec { key: string; item: string; emb: Float32Array; score: number; size: number; box: number[] }

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return Math.fround(s); };
const norm = (a: Float32Array) => { const n = Math.fround(Math.sqrt(dot(a, a))); return n > 0 ? n : 1; };

export class FaceIndex {
  // insertion order matters (it breaks ties): a face put again goes to the end, like Kotlin's LinkedHashMap
  private faces = new Map<string, FaceRec>();
  private byItem = new Map<string, string[]>();

  clear() { this.faces.clear(); this.byItem.clear(); }
  get count() { return this.faces.size; }

  /** Replaces the item's faces: box (x, y, w, h in 0..1), detector score, float16 vector. */
  put(item: string, fs: FaceFound[]) {
    this.remove(item);
    const keys: string[] = [];
    fs.forEach((f, k) => {
      if (f.emb.length < FACE_DIM * 2 || f.box.length !== 4) return;
      const emb = unhalf(f.emb.subarray(0, FACE_DIM * 2));
      if (!allFinite(emb) || !f.box.every(Number.isFinite) || !Number.isFinite(f.score)) return;
      const key = `${item}:${k}`;
      this.faces.set(key, { key, item, emb, score: Math.fround(f.score), size: Math.fround(Math.max(f.box[2], f.box[3])), box: f.box });
      keys.push(key);
    });
    if (keys.length) this.byItem.set(item, keys);
  }

  remove(item: string) {
    for (const k of this.byItem.get(item) ?? []) this.faces.delete(k);
    this.byItem.delete(item);
  }

  facesOf(item: string): { key: string; box: number[]; score: number }[] {
    return (this.byItem.get(item) ?? []).map((k) => this.faces.get(k)!).map((f) => ({ key: f.key, box: f.box, score: f.score }));
  }

  /**
   * Groups faces into people. Faces too small or unclear to compare well are left out. Greedy clustering against each
   * group's running mean; groups whose means are close are joined. The person's own choices win: faces they named
   * (anchors) pull their groups together under that person, faces they took out (rejects) are never in it.
   * Anchors are a list, not an object: their order decides which person a shared group goes to.
   */
  cluster(threshold: number, anchors: [string, string[]][], rejects: Record<string, string[]>, minFaces: number): FaceGroup[] {
    const weight = (f: FaceRec) => Math.fround(f.score * f.size);
    const usable = [...this.faces.values()].filter((f) => f.score >= Math.fround(0.86) && f.size >= Math.fround(0.04))
      .sort((a, b) => weight(b) - weight(a)); // stable, like Kotlin's sortedByDescending
    const t = Math.fround(threshold);
    const means: Float32Array[] = [];
    const members: FaceRec[][] = [];
    for (const f of usable) {
      let best = -1, bestS = t;
      for (let c = 0; c < means.length; c++) {
        const s = Math.fround(dot(means[c], f.emb) / norm(means[c]));
        if (s > bestS) { bestS = s; best = c; }
      }
      if (best < 0) { means.push(Float32Array.from(f.emb)); members.push([f]); }
      else { const m = means[best]; for (let i = 0; i < m.length; i++) m[i] += f.emb[i]; members[best].push(f); }
    }
    // join groups whose means are close: the same person seen in different light or years
    const parent = means.map((_, i) => i);
    const find = (x: number) => { while (parent[x] !== x) x = parent[x]; return x; };
    const unit = means.map((m) => { const n = norm(m); return m.map((x) => x / n); });
    const join = Math.fround(t + 0.05);
    for (let a = 0; a < unit.length; a++) for (let b = a + 1; b < unit.length; b++) if (dot(unit[a], unit[b]) > join) parent[find(b)] = find(a);
    // named people: every group holding one of their faces is theirs
    const group = new Map<string, number>();
    members.forEach((list, c) => { for (const f of list) group.set(f.key, c); });
    const owner = new Map<number, string>();
    for (const [person, keys] of anchors) {
      const gs: number[] = [];
      for (const k of keys) { const g = group.get(k); if (g !== undefined) { const r = find(g); if (!gs.includes(r)) gs.push(r); } }
      if (!gs.length) continue;
      for (const g of gs.slice(1)) parent[find(g)] = find(gs[0]);
      if (!owner.has(find(gs[0]))) owner.set(find(gs[0]), person);
    }
    // a face given to a person (an anchor) is theirs even where the grouping put it with someone else: "move to"
    const anchorOwner = new Map<string, string>();
    for (const [person, keys] of anchors) for (const k of keys) if (!anchorOwner.has(k) && !(rejects[person] ?? []).includes(k)) anchorOwner.set(k, person);
    const rootOf = new Map<string, number>();
    for (const [r, p] of owner) if (!rootOf.has(p)) rootOf.set(p, r);
    const buckets = new Map<string, FaceRec[]>();
    const bucketPerson = new Map<string, string>();
    const add = (b: string, f: FaceRec, person?: string) => {
      if (!buckets.has(b)) { buckets.set(b, []); if (person !== undefined) bucketPerson.set(b, person); }
      buckets.get(b)!.push(f);
    };
    members.forEach((list, c) => {
      const r = find(c);
      for (const f of list) {
        const p = anchorOwner.get(f.key);
        if (p !== undefined && owner.get(r) !== p) {
          const pr = rootOf.get(p);
          add(pr !== undefined ? `r${pr}` : `p${p}`, f, p);
        } else add(`r${r}`, f, owner.get(r));
      }
    });
    return [...buckets.entries()].map(([b, list]): FaceGroup => {
      const person = bucketPerson.get(b);
      const no = new Set(person !== undefined ? rejects[person] ?? [] : []);
      const kept = list.filter((f) => !no.has(f.key));
      let cover: FaceRec | undefined;
      for (const f of kept) if (!cover || weight(f) > weight(cover)) cover = f;
      const items: string[] = [];
      const have = new Set<string>();
      for (const f of kept) if (!have.has(f.item)) { have.add(f.item); items.push(f.item); }
      return { person, faces: kept.map((f) => f.key), items, cover: cover && { key: cover.key, item: cover.item, box: cover.box } };
    }).filter((g) => g.items.length >= minFaces || g.person !== undefined)
      .sort((a, b) => b.items.length - a.items.length);
  }
}
