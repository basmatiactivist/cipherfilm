// Place names on the device (docs/MAP.md): the file scripts/places.mjs builds from GeoNames (CC BY 4.0) holds every
// place with at least 1,000 people. A photo's coordinates are looked up here, never sent anywhere. Shared by the web
// app and the Android app (mobile/ imports it); the Mac reads the same file (Places.swift).

export interface Place {
  name: string;
  region: string; // the admin1 region, e.g. "Zurich"; "" when GeoNames has none
  country: string; // English name, e.g. "Switzerland"
  countryCode: string; // "CH"
  /** The place's own coordinates (not the photo's). */
  lat: number;
  lon: number;
}

const CELL = 1; // grid cell in degrees for the nearest-place search
const NEAR_KM = 50; // farther than this from every place: no place name (but still the country, see below)
const COUNTRY_KM = 300; // farther than this: not even a country (open sea)
const MAX_RADIUS_KM = 15; // no place counts as larger than this around its point

/** How far a place reaches around its point, from its population class (2^size inhabitants): about 0.004 km per
 *  square root of the population (Paris 6 km, Zürich 2.6 km, a town of 60,000 1 km, a village a few hundred
 *  metres), at most MAX_RADIUS_KM. */
export function radiusKm(size: number): number {
  return size ? Math.min(MAX_RADIUS_KM, 0.004 * Math.pow(2, size / 2)) : 0.2;
}

/** Lower case, no accents: "Zürich" and "zurich" match. */
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export class Places {
  readonly n: number;
  private lat: Int32Array;
  private lon: Int32Array;
  private admin: Uint16Array;
  private country: Uint8Array;
  readonly size: Uint8Array;
  readonly names: string[];
  readonly countries: [string, string][];
  readonly admins: [number, string][];
  private grid = new Map<number, number[]>();
  private folded?: string[];

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "CFPL" || dv.getUint8(4) !== 1) throw new Error("not a place file");
    const n = dv.getUint32(8, true), jsonLen = dv.getUint32(12, true);
    let at = 16;
    const take = <T>(make: (b: ArrayBuffer, o: number, l: number) => T, bytes: number, count: number): T => {
      // copied out so the typed arrays are aligned whatever the offset
      const v = make(buf.slice(at, at + bytes * count), 0, count);
      at += bytes * count;
      return v;
    };
    this.n = n;
    this.lat = take((b) => new Int32Array(b), 4, n);
    this.lon = take((b) => new Int32Array(b), 4, n);
    this.admin = take((b) => new Uint16Array(b), 2, n);
    this.country = take((b) => new Uint8Array(b), 1, n);
    this.size = take((b) => new Uint8Array(b), 1, n);
    const dec = new TextDecoder();
    const meta = JSON.parse(dec.decode(new Uint8Array(buf, at, jsonLen)));
    at += jsonLen;
    this.countries = meta.countries;
    this.admins = meta.admins;
    this.names = dec.decode(new Uint8Array(buf, at)).split("\0", n);
    if (this.names.length !== n) throw new Error("place file is cut short");
    for (let i = 0; i < n; i++) {
      const k = this.cell(this.lat[i] / 1e5, this.lon[i] / 1e5);
      const list = this.grid.get(k);
      if (list) list.push(i); else this.grid.set(k, [i]);
    }
  }

  private cell(lat: number, lon: number): number {
    return (Math.floor((lat + 90) / CELL) * 1000) + Math.floor((((lon + 180) % 360) + 360) % 360 / CELL);
  }

  place(i: number): Place {
    const a = this.admin[i];
    const [code, country] = this.countries[this.country[i]];
    return { name: this.names[i], region: a === 65535 ? "" : this.admins[a][1], country, countryCode: code, lat: this.lat[i] / 1e5, lon: this.lon[i] / 1e5 };
  }

  /** The place a photo was taken in: the one whose edge (its point and radiusKm around it) is nearest, so the
   *  Eiffel Tower is in Paris, not in the smaller town whose point happens to be closer; within 50 km. A photo
   *  farther from every place gets only its country (within 300 km), at sea nothing. */
  nearest(lat: number, lon: number): { place?: Place; country?: string; countryCode?: string; km: number } | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    let best = -1, bestKm = Infinity, bestEdge = Infinity;
    // rings of cells around the photo, until the best found is nearer than the ring could hold anything closer
    for (let r = 0; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const la = lat + dy * CELL;
        if (la < -90 || la > 90) continue;
        const list = this.grid.get(this.cell(la, lon + dx * CELL));
        if (!list) continue;
        for (const i of list) {
          const d = km(lat, lon, this.lat[i] / 1e5, this.lon[i] / 1e5);
          const edge = d - radiusKm(this.size[i]);
          if (edge < bestEdge) { bestEdge = edge; bestKm = d; best = i; }
        }
      }
      // a ring r holds nothing closer than about (r) cells of latitude away, and no place reaches more than
      // MAX_RADIUS_KM: stop once the best edge is nearer than that
      if (best >= 0 && bestEdge + MAX_RADIUS_KM < r * CELL * 111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))) break;
    }
    if (best < 0 || bestKm > COUNTRY_KM) return null;
    const p = this.place(best);
    return bestKm <= NEAR_KM ? { place: p, country: p.country, countryCode: p.countryCode, km: bestKm } : { country: p.country, countryCode: p.countryCode, km: bestKm };
  }

  /** Places whose name, region or country starts with the words typed ("zur", "zürich", "switzerland"): the indices
   *  of places matched by name, and the region and country indices matched. */
  match(query: string): { places: Set<number>; admins: Set<number>; countries: Set<number> } {
    const q = fold(query);
    const out = { places: new Set<number>(), admins: new Set<number>(), countries: new Set<number>() };
    if (q.length < 2) return out;
    this.folded ??= this.names.map(fold);
    for (let i = 0; i < this.n; i++) if (this.folded[i] === q || (q.length >= 3 && this.folded[i].startsWith(q))) out.places.add(i);
    this.admins.forEach(([, name], i) => { const f = fold(name); if (f === q || (q.length >= 3 && f.startsWith(q))) out.admins.add(i); });
    this.countries.forEach(([code, name], i) => { if (fold(name) === q || (q.length >= 3 && fold(name).startsWith(q)) || code.toLowerCase() === q) out.countries.add(i); });
    return out;
  }

  /** The index of the nearest place (for match()), -1 if none within 50 km. */
  nearestIndex(lat: number, lon: number): number {
    const r = this.nearest(lat, lon);
    if (!r?.place) return -1;
    // nearest() found it; look it up by its coordinates in its cell
    const list = this.grid.get(this.cell(r.place.lat, r.place.lon)) ?? [];
    return list.find((i) => this.lat[i] / 1e5 === r.place!.lat && this.lon[i] / 1e5 === r.place!.lon && this.names[i] === r.place!.name) ?? -1;
  }

  adminOf(i: number): number { return this.admin[i]; }
  countryOf(i: number): number { return this.country[i]; }
}

/** Great-circle distance in km. */
export function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "Zürich, Switzerland"; the country alone when the photo is far from any place. */
export function label(r: ReturnType<Places["nearest"]>): string {
  if (!r) return "";
  return r.place ? `${r.place.name}, ${r.place.country}` : r.country ?? "";
}

/** What a set of photos' places have in common, for a title: the place when all are in the same one, else the
 *  countries, most photos first ("Switzerland"; "France", "Switzerland", …). Photos at sea or far from any place
 *  count for nothing. */
export function summary(rs: ReturnType<Places["nearest"]>[]): { place?: string; countries: string[] } {
  const labels = new Set<string>();
  const count = new Map<string, number>();
  for (const r of rs) {
    if (!r) continue;
    labels.add(label(r));
    if (r.country) count.set(r.country, (count.get(r.country) ?? 0) + 1);
  }
  const countries = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  return labels.size === 1 && rs.every((r) => r) ? { place: [...labels][0], countries } : { countries };
}
