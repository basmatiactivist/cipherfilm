// Account notices as Android notifications, for when the app isn't open (a new sign-in elsewhere, two-step sign-in
// turned off, an unfinished sign-in). There is no push service (no Google, no Firebase): the background task that also
// runs the backup (backup.ts, WorkManager about every 15 minutes when Android allows) asks the server with the phone's
// session cookie. Notices are not encrypted, so the check needs no key at all; its request is marked as a background
// one, so it doesn't keep the session alive or show the phone as active (server/app.go). The server never lists a
// notice about this phone's own sign-in (server/notices.go shownTo), so the phone never tells itself about itself.
//
// While the app is on screen the bell next to Account counts them (NoticesButton) and nothing is posted; what the app
// loaded is marked seen here, so it doesn't come as a notification later. On by default, Account turns it off; this phone's
// setting, kept in the app's private files. Which ones and their words: noticeAlerts.ts; showing them: Notices.kt.
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import N from "../modules/cf-native/src/CfNativeModule";
import { api, remote } from "./api";
import { type Notice, visibleNotices } from "./notices";
import { alertId, alertText, plan, readSeen, remember, type Seen } from "./noticeAlerts";
import { onSignOut, savedServer } from "./session";

const SETTING = () => new File(Paths.document, "notice-alerts.json");
const DIR = () => new Directory(Paths.document, "notices");
/** the ids already shown; there once the app has loaded the account's notices after signing in */
const SEEN = () => new File(DIR(), "seen.json");

let on = true;
try { const f = SETTING(); if (f.exists) on = JSON.parse(f.textSync()).on !== false; } catch { /* default */ }
const subs = new Set<() => void>();

export const useNoticeAlerts = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => on);
export const noticeAlertsOn = () => on;

/** Account's switch. The caller schedules the background task again (backup.ts scheduleBackground). */
export function setNoticeAlerts(v: boolean) {
  on = v;
  SETTING().write(JSON.stringify({ on: v })).catch(() => { /* stays for this run */ });
  if (!v) { try { N.noticeCancelAll(); } catch { /* older native build */ } }
  subs.forEach((f) => f());
}

/** Whether the background task should run for the notices: switched on, and the app has loaded the account's notices
 *  since signing in (so there is a session; sign-out deletes the list). */
export const noticeCheckWanted = () => on && SEEN().exists;

async function loadSeen(): Promise<Seen | null> {
  try { const f = SEEN(); return f.exists ? readSeen(JSON.parse(await f.text())) : null; } catch { return null; }
}
async function saveSeen(s: Seen) {
  DIR().create({ intermediates: true, idempotent: true });
  await SEEN().write(JSON.stringify(s));
}

/**
 * The app loaded the notices and lists them behind the bell: they are seen (no notification later), and a notification
 * still up for one of them goes. Returns true the first time after signing in (the caller then schedules the
 * background task, which runs from now on for the notices too).
 */
export async function shownInApp(list: Notice[], server: string): Promise<boolean> {
  if (!server) return false;
  const first = !SEEN().exists;
  const seen = await loadSeen();
  const p = plan(list, seen, server, Date.now() / 1000, true);
  try { for (const id of [...list.map((n) => n.id), ...p.cancel]) N.noticeCancel(alertId(id)); } catch { /* older native build */ }
  await saveSeen(remember(seen, server, list.map((n) => n.id))).catch(() => {});
  return first;
}

/** Dismissed in the app: its notification goes too. */
export function dismissedInApp(id: number) {
  try { N.noticeCancel(alertId(id)); } catch { /* older native build */ }
}

/**
 * The background task's check: asks the server and shows what is new. Nothing when switched off, before the app has
 * loaded the notices after signing in, while the app is on screen (the bell counts them), or when the server can't be reached
 * or the session has ended (it tries again at the next run).
 */
export async function checkNotices(): Promise<number> {
  if (!noticeCheckWanted() || AppState.currentState === "active") return 0;
  const server = await savedServer();
  if (!server) return 0;
  let answer: unknown;
  try {
    answer = await api("GET", "/api/me/notices", undefined, { ...remote(server), background: true });
  } catch {
    return 0;
  }
  const list = visibleNotices(answer, new Set());
  const seen = await loadSeen();
  // the person opened the app meanwhile: the bell counts them
  const p = plan(list, seen, server, Date.now() / 1000, AppState.currentState === "active");
  const done = [...p.quiet];
  for (const n of p.show) {
    const w = alertText(n);
    let ok = false;
    try { ok = N.noticeShow(alertId(n.id), w.title, w.text, w.publicTitle); } catch { /* older native build */ }
    // not allowed by Android now: shown once it is (while still recent)
    if (ok) done.push(n.id);
  }
  try { for (const id of p.cancel) N.noticeCancel(alertId(id)); } catch { /* older native build */ }
  // only while still signed in to that server (a sign-out meanwhile deleted the list)
  if (SEEN().exists && (await savedServer()) === server) await saveSeen(remember(seen, server, done)).catch(() => {});
  return done.length - p.quiet.length;
}

// Sign-out: nothing of the account stays, and the setting goes back to the default.
onSignOut(() => {
  try { const d = DIR(); if (d.exists) d.delete(); } catch { /* gone */ }
  try { const f = SETTING(); if (f.exists) f.delete(); } catch { /* gone */ }
  try { N.noticeCancelAll(); } catch { /* older native build */ }
  on = true;
  subs.forEach((f) => f());
});
