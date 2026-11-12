// Which hosts a map setting (server/mapconf.go, `map` in /api/me) loads from, and how the question before the map
// names them. Shared by the web app and the Android app (like places.ts), so both say the same.
type MapConf = { light?: string[]; dark?: string[] } | null | undefined;

/** The server's default map (server/mapconf.go defaultMap): only this exact setting is called OpenFreeMap. */
export const DEFAULT_MAP = {
  light: ["https://tiles.openfreemap.org/styles/positron", "https://tiles.versatiles.org/assets/styles/muted/style.json"],
  dark: ["https://tiles.openfreemap.org/styles/dark", "https://tiles.versatiles.org/assets/styles/colorful-dark/style.json"],
};

/** A style the map may load: an https URL with a plain host name (and port), nothing else. An honest server sends only
 *  those (server/mapconf.go); one that isn't could send inline style JSON or an http:// URL, which MapLibre would load
 *  from hosts the question before the map never named. */
export const httpsStyle = (u: unknown): u is string =>
  typeof u === "string" && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[^\s"'<>\\]*)?$/i.test(u);

/** The map setting from /api/me with only such styles (as the Mac app decodes it); none left on a side: no map. */
export function httpsMap(conf: unknown): { light: string[]; dark: string[] } | undefined {
  const c = conf as { light?: unknown; dark?: unknown } | null | undefined;
  const keep = (l: unknown) => (Array.isArray(l) ? l.filter(httpsStyle) : []);
  const light = keep(c?.light), dark = keep(c?.dark);
  return light.length && dark.length ? { light, dark } : undefined;
}

/** Every host the map may load from, light and dark styles and their fallbacks, in order and once each. */
export function mapHosts(conf: MapConf): string[] {
  const out: string[] = [];
  for (const u of [...(conf?.light ?? []), ...(conf?.dark ?? [])]) {
    // a regex, not URL: React Native's URL has no host (the server accepts only https URLs without a user part)
    const h = /^https:\/\/([^/?#]+)/i.exec(u)?.[1]?.toLowerCase();
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

const isDefault = (conf: MapConf) =>
  !!conf && JSON.stringify(conf.light) === JSON.stringify(DEFAULT_MAP.light) && JSON.stringify(conf.dark) === JSON.stringify(DEFAULT_MAP.dark);

/** Who serves the map images: "OpenFreeMap" for the server's default, else every host the styles name. */
export function mapProviderOf(conf: MapConf): string {
  return isDefault(conf) ? "OpenFreeMap" : mapHosts(conf).join(", ");
}
