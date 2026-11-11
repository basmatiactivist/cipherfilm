// The app's words in the phone's language: English (the source, written in the code) and German. A text is looked up
// by its English wording, so the code stays readable and a missing translation falls back to English instead of a key.
// Placeholders are {name}: t("Backing up {n} of {total}", { n, total }). i18n.test.ts fails when a t("…") in the
// app has no German entry, so nothing new ships half translated.
import { useSyncExternalStore } from "react";
import { de } from "./i18n.de";

export type Lang = "en" | "de";

/** The phone's language, as Hermes reports it (the system locale; an app-specific language from Android 13's
 *  per-app setting also arrives here). Everything that isn't German is English. */
export function detectLang(locale?: string): Lang {
  let l = locale;
  if (!l) {
    try { l = Intl.DateTimeFormat().resolvedOptions().locale; } catch { l = "en"; }
  }
  return /^de\b/i.test(l ?? "") ? "de" : "en";
}

let lang: Lang = detectLang();
const subs = new Set<() => void>();

/** Sets the language; screens that follow it (useLang) render again when it changed. */
export function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  subs.forEach((f) => f());
}
export const currentLang = () => lang;
export function subscribeLang(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
/** The language, for the root that renders the screens again when it changes (app/_layout.tsx). */
export const useLang = () => useSyncExternalStore(subscribeLang, currentLang);

/**
 * Takes up a language change made while the app runs: the phone's language or the app's own (Android 13's per-app
 * setting). The activity isn't recreated then (plugins/withConfigChanges.js), so the app asks again when it comes back
 * to the screen. `now` reads the language the app has now (the native module); without it, the JavaScript engine's.
 * True when it changed.
 */
export function refreshLang(now: () => string | null | undefined = nativeLocale): boolean {
  let l: string | null | undefined;
  try { l = now(); } catch { l = undefined; }
  const next = detectLang(l || undefined);
  if (next === lang) return false;
  setLang(next);
  return true;
}

function nativeLocale(): string | null | undefined {
  try {
    // read when needed, not at import: the unit tests (plain Node) load this file
    const N = require("../modules/cf-native/src/CfNativeModule").default as { appLocale?: () => string | null };
    return N.appLocale?.();
  } catch {
    return undefined;
  }
}
/** The locale for dates and numbers that match the words around them. */
export const locale = () => (lang === "de" ? "de-DE" : "en-US");

/** A key may carry a context before "|" when one English word needs two German ones: t("action|Trash") shows
 *  "Trash" in English and "Löschen" in German, while t("Trash") (the screen) stays „Papierkorb“. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const en = key.includes("|") ? key.slice(key.indexOf("|") + 1) : key;
  const s = lang === "de" ? (de[key] ?? en) : en;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** One or many: tn(n, "{n} photo", "{n} photos"); German entries exist for both forms. */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n: n.toLocaleString(locale()), ...vars });
}
