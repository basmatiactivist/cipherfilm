// Screenshots and screen recordings of the app, and its preview in the recent apps: blocked by default (FLAG_SECURE,
// see ScreenGuard.kt); Account can allow them. The setting is this phone's, kept natively in the app's private
// preferences so the window is protected before any JavaScript runs; this is only the switch's view of it.
import { useSyncExternalStore } from "react";
import N from "../modules/cf-native/src/CfNativeModule";
import { onSignOut } from "./session";

let on = false;
try { on = N.screenshotsAllowed() === true; } catch { /* blocked */ }
const subs = new Set<() => void>();

export const useScreenshots = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => on);

/** Takes effect at once on the open window (no restart) and stays for the next launches. */
export function setScreenshots(v: boolean) {
  try { N.allowScreenshots(v); } catch { return; } // not stored natively: the switch stays as the window is
  on = v;
  subs.forEach((f) => f());
}

// sign-out: back to the default, blocked (registered at start, _layout.tsx, so every way out counts)
onSignOut(() => setScreenshots(false));
