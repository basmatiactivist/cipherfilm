// The app's words in the phone's language: English (the source, written in the code) and German. A text is looked up
// by its English wording, so the code stays readable and a missing translation falls back to English instead of a key.
// Placeholders are {name}: t("Backing up {n} of {total}", { n, total }). i18n.test.ts fails when a t("…") in the
// app has no German entry, so nothing new ships half translated.
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

/** For tests, and for a language change while the app runs (Android restarts the activity then anyway). */
export function setLang(l: Lang) { lang = l; }
export const currentLang = () => lang;
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
