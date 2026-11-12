// Notices: what the other devices of an account show once (server/notices.go). A new sign-in ("Not you? Review
// devices"), two-step sign-in turned off by an administrator, and the password used for a sign-in that wasn't finished
// (no right code followed: "Not you? Change your password"), and a change to two-step sign-in made on another device (an
// authenticator app or a passkey added or removed, new recovery codes, turned off: "Not you? Review two-step sign-in").
// They arrive with the live updates ("notices") and are listed under the bell in the top bar (noticesui.tsx); removing
// one dismisses it on every device, and a dismissed one never comes back.
import { api } from "./api";

/** The changes to two-step sign-in that the account's other devices hear about. */
const TWO_FACTOR = ["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"] as const;
export type Kind = "sign_in" | "2fa_reset" | "password_used" | (typeof TWO_FACTOR)[number];
export interface Notice { id: number; kind: Kind; device: string; at: number }

const KINDS = new Set<string>(["sign_in", "2fa_reset", "password_used", ...TWO_FACTOR]);

/** The notices to show from the server's answer: known kinds only (a newer server may add some), not the ones this
 *  tab already dismissed, newest first. */
export function usable(raw: unknown, dismissed: ReadonlySet<number> = new Set()): Notice[] {
  const list = (raw as { notices?: unknown })?.notices;
  if (!Array.isArray(list)) return [];
  return list
    .filter((n): n is Notice => !!n && typeof n === "object" && typeof n.id === "number" && KINDS.has(n.kind) && typeof n.at === "number")
    .map((n) => ({ id: n.id, kind: n.kind, device: typeof n.device === "string" ? n.device : "", at: n.at }))
    .filter((n) => !dismissed.has(n.id))
    .sort((a, b) => b.at - a.at || b.id - a.id);
}

/** When it happened, in the browser's language and time zone: "5 Mar, 14:02". */
export const when = (at: number): string =>
  new Date(at * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** What happened, as a sentence (the action, "Review devices", is a separate link). */
export function noticeText(n: Notice): string {
  const on = `on ${n.device || "an unknown device"}, ${when(n.at)}`;
  switch (n.kind) {
    case "totp_added": return `An authenticator app was added to two-step sign-in ${on}. Not you?`;
    case "totp_removed": return `The authenticator app was removed from two-step sign-in ${on}. Not you?`;
    case "passkey_added": return `A passkey was added to two-step sign-in ${on}. Not you?`;
    case "passkey_removed": return `A passkey was removed from two-step sign-in ${on}. Not you?`;
    case "recovery_codes": return `New recovery codes were made ${on}; the old ones no longer work. Not you?`;
    case "2fa_off": return `Two-step sign-in was turned off ${on}. Not you?`;
  }
  if (n.kind === "password_used") return `Your password was used to start a sign-in that wasn't finished (${when(n.at)}). Not you?`;
  if (n.kind === "2fa_reset") return `An administrator turned off two-step sign-in for your account (${when(n.at)}). Turn it on again under Account.`;
  return `New sign-in: ${n.device || "an unknown device"}, ${when(n.at)}. Not you?`;
}

/** Where the notice's link goes: the part of Account it opens, and what it says. */
export function noticeAction(n: Notice): { open: "devices" | "2fa" | "password"; label: string } {
  if (n.kind === "sign_in") return { open: "devices", label: "Review devices" };
  if (n.kind === "password_used") return { open: "password", label: "Change your password" };
  if (n.kind === "2fa_reset") return { open: "2fa", label: "Open Account" };
  return { open: "2fa", label: "Review two-step sign-in" };
}

export const dismissNotice = (id: number) => api("POST", `/api/me/notices/${id}/dismiss`);

/** The notices to show. One this tab dismissed whose dismissal didn't reach the server is sent again, so it doesn't
 *  come back on the other devices either. */
export async function loadNotices(dismissed: ReadonlySet<number> = new Set()): Promise<Notice[]> {
  const raw = await api("GET", "/api/me/notices");
  for (const n of usable(raw)) if (dismissed.has(n.id)) dismissNotice(n.id).catch(() => {});
  return usable(raw, dismissed);
}

// Unread: the notices newer than the newest this browser showed in the open list, per account. Notice ids only grow
// (a restore of the server moves them past every one handed out before), so one number per account is enough.
const READ = "cf-notices-read:";

/** The highest notice id this browser has shown for the account (0: none). */
export function readUpTo(account: string): number {
  try { const n = Number(localStorage.getItem(READ + account)); return Number.isSafeInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}

/** Remembers that the list was seen up to id; never goes back to a lower one. */
export function markRead(account: string, id: number): void {
  if (!(id > readUpTo(account))) return;
  try { localStorage.setItem(READ + account, String(id)); } catch { /* storage off: they count as unread again next time */ }
}

/** How many of the notices are unread: newer than upTo. */
export const unreadCount = (list: readonly Notice[], upTo: number): number => list.filter((n) => n.id > upTo).length;

/** The newest id in the list (0 for none). */
export const newestId = (list: readonly Notice[]): number => list.reduce((m, n) => Math.max(m, n.id), 0);
