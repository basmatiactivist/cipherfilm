// Automatic lock: away from the app longer than the chosen time ("Immediately": at every leave), or (if turned on)
// the screen turning off, and the master key leaves memory. Android's own screens that the app opens itself (the photo
// picker, a permission prompt, settings, the share sheet) are no leave: the app marks them first (away, expectAway).
// A native timer (AutoLock.kt) locks while the app is in the background, where React Native's timers stop; on coming
// back, the time away on the monotonic clock (counts deep sleep, can't be set back) catches what the timer missed.
// Uploads from the app need the key, so a lock waits for them; the backup and the background search index never use
// it (they seal to the account's public key) and go on while locked. The settings are this phone's, kept in the
// app's private files.
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { File, Paths } from "expo-file-system";
import N from "../modules/cf-native/src/CfNativeModule";
import { lock, onSignOut, session } from "./session";
import { onUploadsIdle, uploadsRunning } from "./upload";
import { t } from "./i18n";

export interface Settings { after: number; screenOff: boolean }
const DEFAULT: Settings = { after: 5 * 60 * 1000, screenOff: false };
// the labels in the phone's language, read when shown
export const CHOICES = [
  { after: 0, get label() { return t("Immediately"); } },
  { after: 60 * 1000, get label() { return t("After 1 minute"); } },
  { after: 5 * 60 * 1000, get label() { return t("After 5 minutes"); } },
  { after: 15 * 60 * 1000, get label() { return t("After 15 minutes"); } },
];
// a trip to one of the app's own screens locks only after this long (or the chosen time, if longer)
const OWN_MAX = 10 * 60 * 1000;
// expectAway() counts for a leave that follows within this: the screen it was set for opens at once
const STARTS_WITHIN = 5000;
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

// ---- the app's own screens ----
let open = 0; // opened with away() and not answered yet
let openedAt = -1; // the last of those, on the monotonic clock: one that never answers stops counting after OWN_MAX
let markedAt = -1; // expectAway()

/** Marks the next leave as the app's own: call it right before opening an Android screen that gives no answer back
 *  (app settings, the battery list). Unused, it lapses after a few seconds. */
export function expectAway() { markedAt = N.elapsedRealtime(); }

/** Opens an Android screen or prompt that answers (the photo picker, a permission, the share sheet, the fingerprint
 *  prompt): leaving the app for it doesn't lock, and the mark goes once it answered. */
export async function away<T>(show: () => Promise<T>): Promise<T> {
  open++;
  openedAt = N.elapsedRealtime();
  try { return await show(); } finally { open--; }
}

function ownLeave() {
  const now = N.elapsedRealtime();
  return (open > 0 && now - openedAt < OWN_MAX) || (markedAt >= 0 && now - markedAt < STARTS_WITHIN);
}

// due while an upload ran: it locks once the uploads are over
let overdue = false;

/** Locks now, or after the uploads that are running. The unlock screen then asks for the fingerprint at once (only
 *  "Lock now" and shaking wait for a tap). */
function due() {
  if (session().phase !== "unlocked") return;
  if (uploadsRunning() === 0) { overdue = false; lock(); } else overdue = true;
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
  let left = -1;
  let limit = 0; // how long this trip may last: the chosen time, longer for the app's own screens
  AppState.addEventListener("change", (s) => {
    if (s === "background") {
      left = N.elapsedRealtime();
      limit = ownLeave() ? Math.max(settings.after, OWN_MAX) : settings.after;
      markedAt = -1;
      N.lockAfter(limit);
    } else if (s === "active") {
      N.lockCancel();
      markedAt = -1;
      if (left < 0) return;
      const gone = N.elapsedRealtime() - left;
      left = -1;
      if (gone < 0 || gone >= limit) due();
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
