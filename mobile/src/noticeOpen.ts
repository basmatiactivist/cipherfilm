// A tap on a notice's notification (Notices.kt) opens the app with cipherfilm://notice: it goes to Account › Devices,
// after unlocking if the library is locked. +native-intent.ts only notes it here (it can't know whether the library is
// unlocked); the root layout takes it once it is.
let pending = false;
const subs = new Set<() => void>();

/** Whether a link is the notification's. */
export function isNoticeLink(path: string): boolean {
  try { return new URL(path).hostname === "notice"; } catch { return false; }
}

export function openFromNotice() { pending = true; subs.forEach((f) => f()); }

/** True once after a tap on the notification. */
export function takeNoticeOpen(): boolean { const p = pending; pending = false; return p; }

export const onNoticeOpen = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
