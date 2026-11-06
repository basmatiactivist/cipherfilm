// Automatic lock: away from the app longer than the chosen time, or (if turned on) the screen turning off, and the
// master key leaves memory. A native timer (AutoLock.kt) does it while the app is in the background, where React
// Native's timers stop; on coming back, the time away on the monotonic clock (counts deep sleep, can't be set back)
// catches what the timer missed. Uploads from the app need the key, so a lock waits for them; the backup and the
// background search index never use it (they seal to the account's public key) and go on while locked. The settings
// are this phone's, kept in the app's private files.
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { File, Paths } from "expo-file-system";
import N from "../modules/cf-native/src/CfNativeModule";
import { lock, onSignOut, session } from "./session";
import { onUploadsIdle, uploadsRunning } from "./upload";

export interface Settings { after: number; screenOff: boolean }
const DEFAULT: Settings = { after: 5 * 60 * 1000, screenOff: false };
export const CHOICES = [
  { after: 0, label: "Immediately" },
  { after: 60 * 1000, label: "After 1 minute" },
  { after: 5 * 60 * 1000, label: "After 5 minutes" },
  { after: 15 * 60 * 1000, label: "After 15 minutes" },
];
// "Immediately" still lets Android's own screens the app opens (the photo picker, a permission, settings) come back
const GRACE = 10 * 1000;
// after the last upload: not between two files of a share
const AFTER_UPLOADS = 2000;

const FILE = () => new File(Paths.document, "autolock.json");
let settings: Settings = { ...DEFAULT };
try {
  const f = FILE();
  if (f.exists) {
    const v = JSON.parse(f.textSync());
    if (CHOICES.some((c) => c.after === v.after)) settings.after = v.after;
    settings.screenOff = v.screenOff === true;
  }
} catch { /* default */ }
const subs = new Set<() => void>();

export const useAutoLock = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => settings);

export function setAutoLock(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  FILE().write(JSON.stringify(settings)).catch(() => { /* stays for this run */ });
  N.watchScreen(settings.screenOff);
  subs.forEach((f) => f());
}

const wait = () => Math.max(settings.after, GRACE);
// due while an upload ran: it locks once the uploads are over
let overdue = false;

/** Locks now, or after the uploads that are running. Shown as locked: the fingerprint waits for a tap. */
function due() {
  if (session().phase !== "unlocked") return;
  if (uploadsRunning() === 0) { overdue = false; lock(true); } else overdue = true;
}

/** Starts watching (once, from the root layout). */
export function startAutoLock() {
  N.watchScreen(settings.screenOff);
  N.addListener("onLockDue", (e) => {
    if (e.why === "screen" && !settings.screenOff) return;
    due();
  });
  // the native timer: React Native's would not run once the uploads' headless task has ended
  onUploadsIdle(() => { if (overdue) N.lockAfter(AFTER_UPLOADS); });
  let away = -1;
  AppState.addEventListener("change", (s) => {
    if (s === "background") {
      away = N.elapsedRealtime();
      N.lockAfter(wait());
    } else if (s === "active") {
      N.lockCancel();
      if (away < 0) return;
      const gone = N.elapsedRealtime() - away;
      away = -1;
      if (gone < 0 || gone > wait()) due();
    }
  });
}

// sign-out: back to the defaults
onSignOut(() => {
  try { const f = FILE(); if (f.exists) f.delete(); } catch { /* gone */ }
  settings = { ...DEFAULT };
  N.watchScreen(false);
  subs.forEach((f) => f());
});
