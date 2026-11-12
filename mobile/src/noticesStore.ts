// The notices this phone shows (notices.ts): loaded after unlocking and whenever the live stream says "notices".
// Dismissing one tells the server, which takes it down on every device; it is gone here at once, and stays gone even
// if that request fails (it is tried again at the next load). Which ones were read is this phone's own: the highest
// id seen in the notifications list, per account (the bell's badge counts those after it).
import { useSyncExternalStore } from "react";
import { api, server } from "./api";
import { scheduleBackground } from "./backup";
import { dismissedInApp, shownInApp } from "./noticeCheck";
import { type Notice, visibleNotices } from "./notices";
import * as SecureStore from "expo-secure-store";
import { onWipe, session } from "./session";

let list: Notice[] = [];
let dismissed = new Set<number>();
const subs = new Set<() => void>();
let read = { userId: "", id: 0 };
const notify = () => subs.forEach((f) => f());
const set = (l: Notice[]) => { list = l; notify(); };
const readKey = (userId: string) => `notices_read_${userId}`;
const sub = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const useNotices = () => useSyncExternalStore(sub, () => list);
/** The highest notice id read in the list on this phone (0: none yet). */
export const useLastRead = () => useSyncExternalStore(sub, () => read.id);

async function loadRead(): Promise<void> {
  const userId = session().me?.user.id ?? "";
  if (!userId || read.userId === userId) return;
  const v = await SecureStore.getItemAsync(readKey(userId)).catch(() => null);
  read = { userId, id: Number(v) || 0 };
  notify();
}

/** The list was opened: everything in it is read. */
export function markAllRead(): void {
  const userId = session().me?.user.id ?? "";
  const top = list.reduce((m, n) => Math.max(m, n.id), 0);
  if (!userId || top <= read.id) return;
  read = { userId, id: top };
  notify();
  SecureStore.setItemAsync(readKey(userId), String(top)).catch(() => {});
}

export async function refreshNotices(): Promise<void> {
  await loadRead();
  const answer = await api("GET", "/api/me/notices");
  // a dismissal the server didn't get yet: once more
  const listed = visibleNotices(answer, new Set());
  for (const n of listed) if (dismissed.has(n.id)) api("POST", `/api/me/notices/${n.id}/dismiss`).catch(() => {});
  const shown = visibleNotices(answer, dismissed);
  set(shown);
  // shown here: no notification for them later (noticeCheck.ts); the first time after signing in, the background
  // task starts checking for new ones
  shownInApp(listed, server()).then((first) => { if (first) scheduleBackground().catch(() => {}); }, () => {});
}

export async function dismissNotice(id: number): Promise<void> {
  dismissed = new Set(dismissed).add(id);
  set(list.filter((n) => n.id !== id));
  dismissedInApp(id);
  await api("POST", `/api/me/notices/${id}/dismiss`).catch(() => {});
}

// another account or a sign-out: nothing of the old one stays
onWipe((how) => {
  if (how !== "ended") return;
  if (read.userId) SecureStore.deleteItemAsync(readKey(read.userId)).catch(() => {});
  dismissed = new Set(); read = { userId: "", id: 0 }; set([]);
});
