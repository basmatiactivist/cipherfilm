// Where the map opens: the area holding the most photos, at region level. The photos are put into cells of 2° by 2°;
// the fullest cell and its eight neighbours (about 6° across) are what the map shows first, never closer than
// HOME_MAX_ZOOM, so the tile server sees a region (like "Switzerland"), not a street (docs/MAP.md).
// The Mac app's map (mac/Sources/Cipherfilm/Resources/map/map.js) has the same function.
export const HOME_MAX_ZOOM = 8;
const CELL = 2;

export type Bounds = [[number, number], [number, number]];

export function homeBounds(points: { lat: number; lon: number }[]): Bounds | null {
  if (!points.length) return null;
  const key = (lat: number, lon: number) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
  const counts = new Map<string, number>();
  let best = "", most = 0;
  for (const p of points) {
    const k = key(p.lat, p.lon);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > most) { most = n; best = k; }
  }
  const [bl, bo] = best.split(",").map(Number);
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of points) {
    const cl = Math.floor(p.lat / CELL), co = Math.floor(p.lon / CELL);
    if (Math.abs(cl - bl) > 1 || Math.abs(co - bo) > 1) continue;
    w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat);
  }
  return [[w, s], [e, n]];
}
