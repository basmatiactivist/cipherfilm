// The map is off until the person turns it on (docs/MAP.md): the base map's server sees this phone's IP address and
// the areas looked at, so nothing is loaded from it before a yes. Per account on this phone; Account › Map turns it off.
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { privacyUrl } from "./store";
import { session } from "./session";
import { t } from "./i18n";
import { mapProviderOf } from "@places/mapHosts";

const name = (userId: string) => `map_on_${userId}`;
let on: { userId: string; value: boolean } | null = null;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());

/** Reads the setting for the signed-in account (once per account). */
export async function loadMapOn(): Promise<boolean> {
  const id = session().me?.user.id;
  if (!id) return false;
  if (on?.userId !== id) {
    on = { userId: id, value: (await SecureStore.getItemAsync(name(id)).catch(() => null)) === "1" };
    changed();
  }
  return on.value;
}

export async function setMapOn(value: boolean) {
  const id = session().me?.user.id;
  if (!id) return;
  if (value) await SecureStore.setItemAsync(name(id), "1"); else await SecureStore.deleteItemAsync(name(id)).catch(() => {});
  on = { userId: id, value };
  changed();
}

/** Whether the map is on for the signed-in account; false until it was read. */
export function useMapOn(): boolean {
  const id = session().me?.user.id;
  const v = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => (on && on.userId === id ? on.value : false));
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
  return p === "OpenFreeMap" ? t("OpenFreeMap (through Cloudflare; VersaTiles if OpenFreeMap doesn't answer)") : p || t("the map server");
}

/** The privacy policy's part about the map. */
export const mapPrivacyUrl = () => `${privacyUrl()}#map`;
