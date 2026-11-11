// Notices (notices.ts) as the browser's own notifications, while this tab is open but hidden (another tab in front,
// the window minimised). Off unless the person turns it on under Account › Devices, which is when the browser asks for
// the permission; a browser that doesn't have notifications, or a refused permission, keeps it off. Each notice at
// most once in this browser; while the tab is visible the banner shows them and nothing is posted. The title says
// only that something happened ("New sign-in to Cipherfilm"); the body is the banner's sentence. A closed tab gets
// nothing: there is no push service.
import { useEffect, useState } from "preact/hooks";
import { type Notice, noticeText } from "./notices";

const KEY = "cf-notice-alerts";
const SEEN = "cf-notices-seen";
/** notices older than this are not posted any more (seconds) */
export const RECENT = 3 * 24 * 3600;
const KEEP = 200;
const subs = new Set<() => void>();

const supported = () => typeof window !== "undefined" && "Notification" in window;
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage off */ } };

/** Turned on here, and the browser allows it. */
export function browserAlertsOn(): boolean {
  return read(KEY) === "1" && supported() && Notification.permission === "granted";
}
export const browserAlertsPossible = () => supported() && Notification.permission !== "denied";

/** Turns them on (asking the browser, on the person's click) or off; returns whether they are on now. */
export async function setBrowserAlerts(on: boolean): Promise<boolean> {
  if (on && supported()) {
    const p = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    write(KEY, p === "granted" ? "1" : null);
  } else write(KEY, null);
  subs.forEach((f) => f());
  return browserAlertsOn();
}

export function useBrowserAlerts(): boolean {
  const [on, setOn] = useState(browserAlertsOn);
  useEffect(() => {
    const f = () => setOn(browserAlertsOn());
    subs.add(f);
    window.addEventListener("storage", f);
    return () => { subs.delete(f); window.removeEventListener("storage", f); };
  }, []);
  return on;
}

/** Which to post: the new ones (not in seen) while hidden, recent only, oldest first; seen gets every listed id. */
export function pick(list: Notice[], seen: number[], hidden: boolean, now: number): { post: Notice[]; seen: number[] } {
  const known = new Set(seen);
  const fresh = list.filter((n) => !known.has(n.id));
  const all = [...new Set([...seen, ...list.map((n) => n.id)])].sort((a, b) => b - a).slice(0, KEEP);
  const post = hidden ? fresh.filter((n) => n.at >= now - RECENT).sort((a, b) => a.at - b.at || a.id - b.id) : [];
  return { post, seen: all };
}

export const alertTitle = (n: Notice) => (n.kind === "sign_in" ? "New sign-in to Cipherfilm" : "Security notice from Cipherfilm");

/** After loading the notices: the new ones as notifications if this tab is hidden and they are on. Every loaded one
 *  is remembered either way (also when off), so turning them on later doesn't bring old ones. open: a click. */
export function alertNotices(list: Notice[], open: (n: Notice) => void): void {
  let seen: number[] = [];
  try { const v = JSON.parse(read(SEEN) ?? "[]"); if (Array.isArray(v)) seen = v.filter((x) => typeof x === "number"); } catch { /* none */ }
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const r = pick(list, seen, hidden && browserAlertsOn(), Date.now() / 1000);
  write(SEEN, JSON.stringify(r.seen));
  for (const n of r.post) {
    try {
      const x = new Notification(alertTitle(n), { body: noticeText(n), tag: `cf-notice-${n.id}` });
      x.onclick = () => { window.focus(); open(n); x.close(); };
    } catch { /* not allowed after all */ }
  }
}

/** Sign-out: what this browser remembered goes; the choice too (the next account decides for itself). */
export function forgetBrowserAlerts(): void {
  write(SEEN, null);
  write(KEY, null);
  subs.forEach((f) => f());
}
