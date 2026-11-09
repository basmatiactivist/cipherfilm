// The map is off until the person turns it on (docs/MAP.md): the base map's server sees this device's IP address and
// the areas looked at, so nothing is loaded from it before a yes. Per account, in this browser; turned off any time
// under Account › Map.
import { useEffect, useState } from "preact/hooks";
import { mem } from "../state";

const key = () => `cf-map-on:${mem.me?.user.id ?? ""}`;
const subs = new Set<() => void>();

export function mapOn(): boolean {
  try { return !!mem.me && localStorage.getItem(key()) === "1"; } catch { return false; }
}

export function setMapOn(on: boolean) {
  try { if (on) localStorage.setItem(key(), "1"); else localStorage.removeItem(key()); } catch { /* storage off: the map stays off */ }
  subs.forEach((f) => f());
}

/** Whether the map is on, kept current when it is switched here or in another tab. */
export function useMapOn(): boolean {
  const [on, setOn] = useState(mapOn);
  useEffect(() => {
    const f = () => setOn(mapOn());
    subs.add(f);
    window.addEventListener("storage", f);
    return () => { subs.delete(f); window.removeEventListener("storage", f); };
  }, []);
  return on;
}

/** Who serves the map images: "OpenFreeMap" for the default, else the host of the server's own style. */
export function mapProvider(): string {
  const u = mem.me?.map?.light?.[0];
  if (!u) return "";
  try { const h = new URL(u).host; return h === "tiles.openfreemap.org" ? "OpenFreeMap" : h; } catch { return ""; }
}

export const PRIVACY_URL = "https://cipherfilm.app/privacy#map";
