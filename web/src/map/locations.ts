// Where photos were taken, from their encrypted metadata (docs/MAP.md): only this device ever sees the coordinates.
// Place names come from the GeoNames file bundled with the app (places/places.ts), loaded once when first needed.
import placesUrl from "../places/places-v1.bin?url";
import { fold, label, Places } from "../places/places";
import type { Item } from "../items";

export interface Located { item: Item; lat: number; lon: number }

/** Coordinates a camera really wrote: in range, and not exactly 0,0 (what broken GPS writes). */
export function coords(it: Item): { lat: number; lon: number } | null {
  if (it.broken || it.trashed_at) return null;
  const g = it.meta?.gps;
  if (!g || typeof g.lat !== "number" || typeof g.lon !== "number") return null;
  const { lat, lon } = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

export function located(items: Item[]): Located[] {
  const out: Located[] = [];
  for (const item of items) {
    const c = coords(item);
    if (c) out.push({ item, ...c });
  }
  return out;
}

let places: Promise<Places> | null = null;
/** The place file, fetched from this server once (a few MB, then in the browser's cache). */
export function loadPlaces(): Promise<Places> {
  places ??= fetch(placesUrl).then((r) => {
    if (!r.ok) throw new Error(`places: HTTP ${r.status}`);
    return r.arrayBuffer();
  }).then((b) => new Places(b)).catch((e) => { places = null; throw e; });
  return places;
}

/** "Zürich, Switzerland" for a photo with coordinates; "" when it has none or the file can't be loaded. */
export async function placeName(it: Item): Promise<string> {
  const c = coords(it);
  if (!c) return "";
  try { return label((await loadPlaces()).nearest(c.lat, c.lon)); } catch { return ""; }
}

/** For search: each located photo's place words (town, region, country, its code), as written and without accents,
 *  so "zurich", "Zürich", "switzerland" and "ch" all find it. Photos far from any town get only their country. */
export async function placeWords(items: Item[]): Promise<Map<string, string>> {
  const p = await loadPlaces();
  const out = new Map<string, string>();
  for (const l of located(items)) {
    const r = p.nearest(l.lat, l.lon);
    if (!r) continue;
    const words = [r.place?.name ?? "", r.place?.region ?? "", r.country ?? "", r.countryCode ?? ""].filter(Boolean).join(" ");
    out.set(l.item.id, `${words} ${fold(words)}`);
  }
  return out;
}
