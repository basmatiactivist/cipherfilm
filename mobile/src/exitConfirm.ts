// Back on one of the top-level places (Photos, Search, Albums, Map) would close the app at once. Instead Cipherfilm
// asks first, and says what keeps going (uploads, backup) once it is closed. The question can be turned off in
// Account. The setting is this phone's, kept in the app's private files (like shake.ts). This part decides; the dialog
// is ExitDialog.tsx.
import { useSyncExternalStore } from "react";

/** The places in the navigation bar: Back there leaves the app. */
export const TOP_LEVEL = new Set(["library", "search", "albums", "map"]);

/** Whether Back should ask before closing: on a top-level place with nothing under it, with the question on. */
export function shouldAsk(p: { top: string | undefined; canGoBack: boolean; on: boolean }): boolean {
  return p.on && !p.canGoBack && TOP_LEVEL.has(p.top ?? "");
}

const FILE = () => {
  const { File, Paths } = require("expo-file-system") as typeof import("expo-file-system");
  return new File(Paths.document, "exit-confirm.json");
};

let on = true;
let read = false;
function load() {
  if (read) return;
  read = true;
  try { const f = FILE(); if (f.exists) on = JSON.parse(f.textSync()).on !== false; } catch { /* default: ask */ }
}
const subs = new Set<() => void>();

export const askBeforeClosing = () => { load(); return on; };
export const useAskBeforeClosing = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, askBeforeClosing);

export function setAskBeforeClosing(v: boolean) {
  load();
  on = v;
  Promise.resolve().then(() => FILE().write(JSON.stringify({ on: v }))).catch(() => { /* stays for this run */ });
  subs.forEach((f) => f());
}
