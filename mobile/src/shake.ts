// Shake to lock and close: two strong jolts lock the library (the key leaves memory, decrypted images and shared
// copies are wiped) and close the app, out of the recent apps too, like some banking apps do in case the phone is
// grabbed. On by default; Account turns it off. The setting is this phone's, kept in the app's private files.
import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import N from "../modules/cf-native/src/CfNativeModule";
import { lock, onSignOut, session } from "./session";
import { clearImages } from "./library";
import { clearOutbox } from "./outbox";

const FILE = () => new File(Paths.document, "shake.json");

let on = true;
try { const f = FILE(); if (f.exists) on = JSON.parse(f.textSync()).on !== false; } catch { /* default */ }
const subs = new Set<() => void>();

export const useShake = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => on);

export function setShake(v: boolean) {
  on = v;
  FILE().write(JSON.stringify({ on: v })).catch(() => { /* stays for this run */ });
  N.shakeWatch(v);
  subs.forEach((f) => f());
}

/** Starts listening (only while the app is on screen, see Shake.kt). */
export function startShake() {
  N.shakeWatch(on);
  N.addListener("onShake", () => {
    if (!on) return;
    const p = session().phase;
    if (p !== "unlocked" && p !== "locked") return;
    clearImages();
    clearOutbox();
    lock(true); // the unlock screen then waits for a tap: the phone may be in someone else's hand
    N.haptic();
    N.closeApp();
  });
}

// sign-out: back to the default
onSignOut(() => { try { const f = FILE(); if (f.exists) f.delete(); } catch { /* gone */ } on = true; });
