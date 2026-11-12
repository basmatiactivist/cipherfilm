// Which account notices (notices.ts) become Android notifications, and their words. No React Native and no files here:
// noticeCheck.ts reads the server and the phone and hands this what it found.
//
// A notice is shown at most once per phone: its id goes into the "seen" list as soon as it was shown as a
// notification, or in the app behind the bell (then no notification follows). Old ones (from before RECENT) are only
// marked seen: a phone that was off for a week doesn't get a pile of them, the notifications list still shows them.
import { isTwoStepChange, type Notice, noticeText } from "./notices";
import { t } from "./i18n";

export interface Seen {
  /** the server the ids are from (ids are the server's, shared by all its accounts) */
  server: string;
  ids: number[];
}

/** notices older than this are not shown as a notification any more (seconds) */
export const RECENT = 3 * 24 * 3600;
/** how many ids are kept: the server lists at most 20 per account */
export const KEEP = 200;
/** the server lists at most this many (server/notices.go listNotices) */
const LISTED = 20;

export interface Plan {
  /** to show as a notification now, oldest first (the newest ends on top) */
  show: Notice[];
  /** to mark seen without a notification */
  quiet: number[];
  /** shown before and no longer listed (dismissed on some device): their notifications go */
  cancel: number[];
}

/**
 * What to do with the server's list. In the foreground the bell counts them: nothing is shown as a notification
 * then, and everything new is marked seen.
 */
export function plan(list: Notice[], seen: Seen | null, server: string, now: number, foreground: boolean): Plan {
  const known = new Set(seen && seen.server === server ? seen.ids : []);
  const fresh = list.filter((n) => !known.has(n.id));
  const listed = new Set(list.map((n) => n.id));
  // an id below the oldest listed one may only have been pushed out of the 20 the server lists, not dismissed
  const oldest = list.length >= LISTED ? Math.min(...list.map((n) => n.id)) : -Infinity;
  const cancel = [...known].filter((id) => !listed.has(id) && id > oldest);
  if (foreground) return { show: [], quiet: fresh.map((n) => n.id), cancel };
  const show = fresh.filter((n) => n.at >= now - RECENT).sort((a, b) => a.at - b.at || a.id - b.id);
  const quiet = fresh.filter((n) => n.at < now - RECENT).map((n) => n.id);
  return { show, quiet, cancel };
}

/** The seen list with ids added (the newest KEEP), for this server. */
export function remember(seen: Seen | null, server: string, ids: number[]): Seen {
  const all = new Set([...(seen && seen.server === server ? seen.ids : []), ...ids]);
  return { server, ids: [...all].filter((x) => Number.isSafeInteger(x)).sort((a, b) => b - a).slice(0, KEEP) };
}

/** A seen list as read from the phone's file: anything else counts as none. */
export function readSeen(v: unknown): Seen | null {
  const s = v as Partial<Seen> | null;
  if (!s || typeof s.server !== "string" || !Array.isArray(s.ids)) return null;
  return { server: s.server, ids: s.ids.filter((x): x is number => typeof x === "number") };
}

/**
 * The notification's words: the title, the text (what the notifications list says: the device's own label and the time) and
 * the public version the lock screen shows, which says nothing about the device or the time.
 */
export function alertText(n: Notice): { title: string; text: string; publicTitle: string } {
  const title = n.kind === "sign_in" ? t("New sign-in") : n.kind === "2fa_reset" || n.kind === "2fa_off" ? t("Two-step sign-in turned off")
    : isTwoStepChange(n.kind) ? t("Two-step sign-in changed") : t("Unfinished sign-in");
  const publicTitle = n.kind === "sign_in" ? t("New sign-in to Cipherfilm") : t("Security notice from Cipherfilm");
  return { title, text: noticeText(n), publicTitle };
}

/** Android's notification id for a notice (an int). */
export const alertId = (id: number) => id % 2147483647;
