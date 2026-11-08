// German texts, keyed by the English wording in the code (i18n.ts). One file per part of the app, so they can grow
// independently; a key that appears in two files must say the same.
import { deBackup } from "./i18n/de.backup";
import { deSearch } from "./i18n/de.search";
import { deApp } from "./i18n/de.app";
import { deReport } from "./i18n/de.report";

export const de: Record<string, string> = { ...deApp, ...deSearch, ...deBackup, ...deReport };
