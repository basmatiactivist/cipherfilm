// Place names on the phone (docs/MAP.md): the GeoNames file shared with the web app (web/src/places), bundled as an
// asset and read once when the map, a photo's details or a search needs it. A photo's coordinates never leave the phone.
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { fold, label, Places, type Place } from "@places/places";
import type { Item } from "./library";

export { label, type Place };

let loading: Promise<Places> | null = null;

export function loadPlaces(): Promise<Places> {
  loading ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const a = Asset.fromModule(require("../../web/src/places/places-v1.bin"));
    await a.downloadAsync();
    const bytes = await new File(a.localUri ?? a.uri).bytes();
    return new Places(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Coordinates a camera really wrote: in range, and not exactly 0,0 (what broken GPS writes). */
export function coords(it: Item): { lat: number; lon: number } | null {
  if (it.broken || it.trashed_at) return null;
  const g = it.meta?.gps;
  if (!g || typeof g.lat !== "number" || typeof g.lon !== "number") return null;
  const { lat, lon } = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** "Zürich, Switzerland" for a photo with coordinates, "" otherwise. */
export async function placeName(it: Item): Promise<string> {
  const c = coords(it);
  if (!c) return "";
  try { return label((await loadPlaces()).nearest(c.lat, c.lon)); } catch { return ""; }
}

/** For search: the photos taken in the place, region or country named ("zurich", "Zürich", "switzerland", "new york"),
 *  and that name as found; null when the words name no place. */
export async function inPlace(items: Item[], words: string): Promise<{ ids: Set<string>; name: string } | null> {
  const q = fold(words);
  if (q.length < 3) return null;
  const p = await loadPlaces();
  const ids = new Set<string>();
  let name = "";
  for (const it of items) {
    const c = coords(it);
    if (!c) continue;
    const r = p.nearest(c.lat, c.lon);
    if (!r) continue;
    const hit = [r.place?.name, r.place?.region, r.country].find((n) => n && (fold(n) === q || fold(n).startsWith(q)));
    if (hit) { ids.add(it.id); name ||= hit; }
  }
  return ids.size ? { ids, name } : null;
}
