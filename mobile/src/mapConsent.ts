// The map is off until the person turns it on (docs/MAP.md): the base map's server sees this phone's IP address and
// the areas looked at, so nothing is loaded from it before a yes. Per account on this phone; Account › Map turns it off.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";
import { privacyUrl } from "./store";
import { onWipe, session } from "./session";
import { OfflineManager } from "@maplibre/maplibre-react-native";
import { t } from "./i18n";
import { mapHosts, mapProviderOf } from "@places/mapHosts";

const name = (userId: string) => `map_on_${userId}`;
// what is stored is the map servers agreed to: another map server on the Cipherfilm server (MAP_STYLE) asks again
let on: { userId: string; stored: string | null } | null = null;
const agreed = () => mapHosts(session().me?.map).join(" ");
const isOn = (stored: string | null | undefined) => !!stored && stored === agreed();
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());

/** Reads the setting for the signed-in account (once per account). */
export async function loadMapOn(): Promise<boolean> {
  const id = session().me?.user.id;
  if (!id) return false;
  if (on?.userId !== id) {
    on = { userId: id, stored: await SecureStore.getItemAsync(name(id)).catch(() => null) };
    changed();
  }
  return isOn(on.stored);
}

export async function setMapOn(value: boolean) {
  const id = session().me?.user.id;
  if (!id) return;
  const hosts = agreed();
  if (value && hosts) await SecureStore.setItemAsync(name(id), hosts); else await SecureStore.deleteItemAsync(name(id)).catch(() => {});
  on = { userId: id, stored: value && hosts ? hosts : null };
  changed();
  if (!value) clearMapCache();
}

/** Whether the map is on for the signed-in account; false until it was read. */
export function useMapOn(): boolean {
  const id = session().me?.user.id;
  const v = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => (on && on.userId === id ? isOn(on.stored) : false));
  if (id && on?.userId !== id) loadMapOn();
  return v;
}

/** Who serves the map images: "OpenFreeMap" for the server's default, else every host the styles name. */
export function mapProvider(): string {
  return mapProviderOf(session().me?.map);
}

/** Who serves the map images, as the question before the map says it: with the CDN and the fallback for the default. */
export function mapProviderLong(): string {
  const p = mapProvider();
  return p === "OpenFreeMap" ? t("an external map service") : p || t("the map server");
}

/** The privacy policy's part about the map. */
export const mapPrivacyUrl = () => `${privacyUrl()}#map`;

// MapLibre keeps the map images it loaded in a cache in the app's storage, which tells where the map was looked at.
// It goes when the app locks or signs out and when the map is turned off, and once per start before the first map
// shows (for an app that was closed while unlocked). The cache outlives the app's process, so a mark in the app's
// files says that a map was shown since the cache was last cleared: a run that shows no map still clears it at a lock,
// a sign-out or the map turned off. Nothing calls into MapLibre while no map was ever shown.
let cacheChecked: Promise<void> | null = null;
let shown = false;
const USED = () => new File(Paths.document, "map-cache-used");
const marked = () => { try { return USED().exists; } catch { return true; } };
const clearCache = () => OfflineManager.clearAmbientCache().then(
  // (a map shown in this run may still be loading images: the mark stays for the next run's clear)
  () => { if (!shown) try { USED().delete(); } catch { /* cleared again next time */ } },
  () => {},
);

/** Before a map shows: the cache from an earlier run is gone. */
export function mapCacheReady(): Promise<void> {
  shown = true;
  try { if (!USED().exists) USED().write("1"); } catch { /* this run still clears it */ }
  cacheChecked ??= clearCache();
  return cacheChecked;
}

/** After the map was on screen, in this run or an earlier one: the cache is cleared (lock, sign-out, map turned off). */
export function clearMapCache(): Promise<void> {
  return shown || marked() ? clearCache() : Promise.resolve();
}

onWipe((how) => {
  clearMapCache();
  if (how === "ended") { on = null; changed(); } // read again for the next account (sign-out deletes the stored yes)
});
