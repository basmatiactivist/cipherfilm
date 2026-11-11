// The notices this phone shows (notices.ts): loaded after unlocking and whenever the live stream says "notices".
// Dismissing one tells the server, which takes it down on every device; it is gone here at once, and stays gone even
// if that request fails (it is tried again at the next load).
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { type Notice, visibleNotices } from "./notices";
import { onWipe } from "./session";

let list: Notice[] = [];
let dismissed = new Set<number>();
const subs = new Set<() => void>();
const set = (l: Notice[]) => { list = l; subs.forEach((f) => f()); };

export const useNotices = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => list);

export async function refreshNotices(): Promise<void> {
  const answer = await api("GET", "/api/me/notices");
  // a dismissal the server didn't get yet: once more
  const server = visibleNotices(answer, new Set());
  for (const n of server) if (dismissed.has(n.id)) api("POST", `/api/me/notices/${n.id}/dismiss`).catch(() => {});
  set(visibleNotices(answer, dismissed));
}

export async function dismissNotice(id: number): Promise<void> {
  dismissed = new Set(dismissed).add(id);
  set(list.filter((n) => n.id !== id));
  await api("POST", `/api/me/notices/${id}/dismiss`).catch(() => {});
}

// another account or a sign-out: nothing of the old one stays
onWipe((how) => { if (how === "ended") { dismissed = new Set(); set([]); } });
