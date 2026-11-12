// The map is off until the person turns it on (docs/MAP.md): the base map's server sees this device's IP address and
// the areas looked at, so nothing is loaded from it before a yes. Per account, in this browser; turned off any time
// under Account › Map.
import { useEffect, useState } from "preact/hooks";
import { mem } from "../state";
import { mapHosts, mapProviderOf } from "../places/mapHosts";

const key = () => `cf-map-on:${mem.me?.user.id ?? ""}`;
const subs = new Set<() => void>();

// what is stored is the map servers agreed to: another map server on the Cipherfilm server (MAP_STYLE) asks again
const agreed = () => mapHosts(mem.me?.map).join(" ");

export function mapOn(): boolean {
  try { return !!mem.me && !!agreed() && localStorage.getItem(key()) === agreed(); } catch { return false; }
}

export function setMapOn(on: boolean) {
  try { if (on) localStorage.setItem(key(), agreed()); else localStorage.removeItem(key()); } catch { /* storage off: the map stays off */ }
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

export function mapProvider(): string {
  return mapProviderOf(mem.me?.map);
}

/** Who serves the map images, as the question before the map says it: with the CDN and the fallback for the default. */
export function mapProviderLong(): string {
  const p = mapProvider();
  return p === "OpenFreeMap" ? "an external map service" : p || "the map server";
}

export const PRIVACY_URL = "https://cipherfilm.app/privacy#map";
