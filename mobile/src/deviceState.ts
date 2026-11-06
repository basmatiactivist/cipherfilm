// What Android allows the app (photos, notifications, running in the background), as the Backup and Search screens
// show it. Read again each time the app comes back on screen, which is how the person returns from Android's settings.
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";

/** Calls f each time the app comes back on screen, and again a moment later: Android applies some changes (the battery
 *  exemption right after its dialog) only once the app is back, so the first read can still show the old state. */
export function useOnReturn(f: () => void) {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      latest.current();
      timers.push(setTimeout(() => latest.current(), 1000), setTimeout(() => latest.current(), 3000));
    });
    return () => { sub.remove(); timers.forEach(clearTimeout); };
  }, []);
}

/** Xiaomi's own Android (MIUI, HyperOS) has its own per-app battery setting ("Battery saver: No restrictions") that
 *  Android's battery optimisation list doesn't show: the app can't see it, so the screens say where it is instead. */
export function ownBatteryRules(): boolean {
  const c = Platform.constants as { Manufacturer?: string; Brand?: string };
  return /xiaomi|redmi|poco/i.test(`${c.Manufacturer ?? ""} ${c.Brand ?? ""}`);
}
