// Notices: what the other devices of an account show once (server/notices.go). A new sign-in ("Not you? Review
// devices"), two-step sign-in turned off by an administrator, and the password used for a sign-in that wasn't finished
// (no right code followed: "Not you? Change your password"). They arrive with the live updates ("notices"),
// dismissing one dismisses it on every device, and a dismissed one never comes back.
import { api } from "./api";

export interface Notice { id: number; kind: "sign_in" | "2fa_reset" | "password_used"; device: string; at: number }

const KINDS = new Set(["sign_in", "2fa_reset", "password_used"]);

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

/** The banner's sentence (the action, "Review devices", is a separate link). */
export function noticeText(n: Notice): string {
  if (n.kind === "password_used") return `Your password was used to start a sign-in that wasn't finished (${when(n.at)}). Not you?`;
  if (n.kind === "2fa_reset") return `An administrator turned off two-step sign-in for your account (${when(n.at)}). Turn it on again under Account.`;
  return `New sign-in: ${n.device || "an unknown device"}, ${when(n.at)}. Not you?`;
}

/** Where the banner's link goes: the part of Account it opens, and what it says. */
export function noticeAction(n: Notice): { open: "devices" | "2fa" | "password"; label: string } {
  if (n.kind === "sign_in") return { open: "devices", label: "Review devices" };
  if (n.kind === "password_used") return { open: "password", label: "Change your password" };
  return { open: "2fa", label: "Open Account" };
}

export const dismissNotice = (id: number) => api("POST", `/api/me/notices/${id}/dismiss`);

/** The notices to show. One this tab dismissed whose dismissal didn't reach the server is sent again, so it doesn't
 *  come back on the other devices either. */
export async function loadNotices(dismissed: ReadonlySet<number> = new Set()): Promise<Notice[]> {
  const raw = await api("GET", "/api/me/notices");
  for (const n of usable(raw)) if (dismissed.has(n.id)) dismissNotice(n.id).catch(() => {});
  return usable(raw, dismissed);
}
