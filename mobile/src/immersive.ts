// The viewer's full screen: with its own bars hidden, Android's status and navigation bars go too; a swipe from the
// edge brings them back for a moment (CfNativeModule.kt, systemBars). Whoever hides them shows them again when it goes.
import { StatusBar } from "react-native";
import N from "../modules/cf-native/src/CfNativeModule";

export function hideSystemBars(hide: boolean) {
  // a JS bundle newer than the installed app (development only) has no systemBars: then at least the status bar
  if (typeof N.systemBars === "function") N.systemBars(hide);
  else StatusBar.setHidden(hide, "fade");
}

export interface Insets { top: number; bottom: number; left: number; right: number }

/** The safe-area insets with the system bars shown, also while they are hidden: hidden bars take no room, so the insets
 *  drop to 0 and would move the viewer's bars and the loading badge each time. The largest seen per side is the room
 *  the system bars take (the app is portrait only, so it doesn't change while the viewer is open). */
export const largestInsets = (kept: Insets, now: Insets): Insets =>
  now.top <= kept.top && now.bottom <= kept.bottom && now.left <= kept.left && now.right <= kept.right ? kept : {
    top: Math.max(kept.top, now.top), bottom: Math.max(kept.bottom, now.bottom),
    left: Math.max(kept.left, now.left), right: Math.max(kept.right, now.right),
  };
