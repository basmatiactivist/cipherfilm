import { currentLang } from "./i18n";
// Which build this is: "play" for Google Play (built with CF_STORE=play), "github" for the APK on GitHub releases
// (Obtainium). app.config.js puts it into the app's config (extra.store) at build time. The Play build never offers
// the explicit search model (docs/SEARCH.md; the server's permission for it stays as it is) and doesn't ask Android
// directly for the battery exemption (no REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in its manifest).
export type Store = "play" | "github";

let store: Store | undefined;
export function buildStore(): Store {
  if (store) return store;
  try {
    // read when first needed, not at import: the unit tests (plain Node) load modules that use this
    const Constants = require("expo-constants").default as typeof import("expo-constants").default;
    store = (Constants.expoConfig?.extra as { store?: unknown } | undefined)?.store === "play" ? "play" : "github";
  } catch {
    store = "github";
  }
  return store;
}

export const isPlayBuild = () => buildStore() === "play";
/** Whether this build may offer explicit search where an admin allowed it. */
export const explicitSearchOffered = () => !isPlayBuild();

/** The app's privacy policy (Google Play wants it reachable inside the app, before and after sign-in), in the
 *  language the app speaks. */
export const privacyUrl = () => (currentLang() === "de" ? "https://cipherfilm.app/de/privacy" : "https://cipherfilm.app/privacy");
