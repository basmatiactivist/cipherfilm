// Thumbnails in batches. A grid asks for dozens at once, and one request each costs a round trip each (slow over
// the internet or a VPN). The thumbnails asked for within a few milliseconds go out in one request,
// POST /api/items/thumbs, newest request first: what is on screen now. Against a server without that endpoint
// (404/405) every thumbnail is fetched on its own, as before.
//
// The answer, for each id in the order asked: u32 big-endian length, then that many bytes of the same ciphertext the
// single request returns; 0xFFFFFFFF when the server has no thumbnail for it.

export const BATCH = 100; // the server's limit
const WINDOW_MS = 15;

/** Splits the answer into each id's ciphertext, or null (no thumbnail, or the answer was cut short). */
export function splitThumbs(b: Uint8Array, n: number): (Uint8Array | null)[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: (Uint8Array | null)[] = [];
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (o + 4 > b.length) { out.push(null); continue; }
    const len = v.getUint32(o);
    o += 4;
    if (len === 0xffffffff) { out.push(null); continue; }
    if (o + len > b.length) { out.push(null); o = b.length; continue; }
    out.push(b.slice(o, o + len)); // a copy: kept on its own, the whole answer is not held
    o += len;
  }
  return out;
}

interface Ask { id: string; wanted: () => boolean; res: (ct: Uint8Array) => void; rej: (e: unknown) => void }

const gone = (e: unknown) => { const s = (e as { status?: number } | null)?.status; return s === 404 || s === 405; };

export class ThumbBatcher {
  private asks: Ask[] = [];
  private byId = new Map<string, Ask>(); // the asks not yet sent, so the same thumbnail is asked for once
  private scheduled = false;
  private single = false;

  /** `many` posts the ids and returns the raw answer; `one` fetches a single thumbnail (the fallback). */
  constructor(private many: (ids: string[]) => Promise<Uint8Array>, private one: (id: string, wanted: () => boolean) => Promise<Uint8Array>) {}

  /** The ciphertext of one thumbnail. Rejects with "cancelled" when nobody wants it any more by the time it is sent. */
  get(id: string, wanted: () => boolean): Promise<Uint8Array> {
    if (this.single) return this.one(id, wanted);
    return new Promise((res, rej) => {
      const had = this.byId.get(id);
      if (had) {
        const { wanted: w, res: r, rej: j } = had;
        Object.assign(had, { wanted: () => w() || wanted(), res: (ct: Uint8Array) => { r(ct); res(ct); }, rej: (e: unknown) => { j(e); rej(e); } });
        return;
      }
      const a = { id, wanted, res, rej };
      this.asks.push(a);
      this.byId.set(id, a);
      if (!this.scheduled) { this.scheduled = true; setTimeout(() => void this.flush(), WINDOW_MS); }
    });
  }

  private async flush() {
    this.scheduled = false;
    const asks = this.asks.reverse(); // newest request first
    this.asks = [];
    this.byId.clear();
    while (asks.length) {
      const chunk: Ask[] = [];
      while (asks.length && chunk.length < BATCH) {
        const a = asks.shift()!;
        if (a.wanted()) chunk.push(a); else a.rej(new Error("cancelled")); // its tile scrolled away
      }
      if (!chunk.length) return;
      try {
        const got = splitThumbs(await this.many(chunk.map((a) => a.id)), chunk.length);
        chunk.forEach((a, i) => { const ct = got[i]; if (ct) a.res(ct); else a.rej(new Error("no thumbnail")); });
      } catch (e) {
        if (!gone(e)) { chunk.forEach((a) => a.rej(e)); continue; }
        this.single = true; // an older server
        for (const a of [...chunk, ...asks]) this.one(a.id, a.wanted).then(a.res, a.rej);
        return;
      }
    }
  }
}
