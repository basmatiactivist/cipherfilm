// Notices: what the server asks every other device of the account to show once (server/notices.go): a new sign-in,
// an administrator turning two-step sign-in off, the password used for a sign-in that wasn't finished (no right
// code followed), or a change to two-step sign-in made on another device (an authenticator app or a passkey added or
// removed, new recovery codes, turned off). This part has no React Native: it checks what arrived, keeps only
// kinds it knows, and words them. The store (noticesStore.ts) fetches and dismisses.
import { locale, t } from "./i18n";

/** Changes to two-step sign-in made on one of the account's devices (`device` made them). */
export type TwoStepChange = "totp_added" | "totp_removed" | "passkey_added" | "passkey_removed" | "recovery_codes" | "2fa_off";
export type NoticeKind = "sign_in" | "2fa_reset" | "password_used" | TwoStepChange;
export interface Notice { id: number; kind: NoticeKind; device: string; at: number }
const CHANGES = new Set<string>(["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"]);
const KINDS = new Set<string>(["sign_in", "2fa_reset", "password_used", ...CHANGES]);
/** Whether the notice is a change to two-step sign-in made on a device of the account. */
export const isTwoStepChange = (k: NoticeKind): k is TwoStepChange => CHANGES.has(k);

/** The notices to show from a server answer: well formed, of a known kind, not dismissed here, newest first. */
export function visibleNotices(answer: unknown, dismissed: ReadonlySet<number>): Notice[] {
  const list = (answer as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list)) return [];
  const out: Notice[] = [];
  for (const x of list) {
    const n = x as Partial<Notice> | null;
    if (!n || typeof n.id !== "number" || typeof n.kind !== "string" || !KINDS.has(n.kind) || typeof n.at !== "number" || dismissed.has(n.id)) continue;
    out.push({ id: n.id, kind: n.kind as NoticeKind, device: typeof n.device === "string" ? n.device : "", at: n.at });
  }
  return out.sort((a, b) => b.at - a.at || b.id - a.id);
}

/** When it happened, in the phone's language. */
export const noticeTime = (at: number): string =>
  new Date(at * 1000).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function noticeText(n: Notice): string {
  const time = noticeTime(n.at);
  const device = n.device || t("an unknown device");
  switch (n.kind) {
    case "totp_added": return t("An authenticator app was added to two-step sign-in on {device}, {time}. Not you?", { device, time });
    case "totp_removed": return t("The authenticator app was removed from two-step sign-in on {device}, {time}. Not you?", { device, time });
    case "passkey_added": return t("A passkey was added to two-step sign-in on {device}, {time}. Not you?", { device, time });
    case "passkey_removed": return t("A passkey was removed from two-step sign-in on {device}, {time}. Not you?", { device, time });
    case "recovery_codes": return t("New recovery codes were made on {device}, {time}; the old ones no longer work. Not you?", { device, time });
    case "2fa_off": return t("Two-step sign-in was turned off on {device}, {time}. Not you?", { device, time });
  }
  // the password is changed in the browser (Account says so)
  if (n.kind === "password_used") return t("Your password was used to start a sign-in that wasn't finished ({time}). Not you? Change your password in Cipherfilm in the browser.", { time });
  if (n.kind === "2fa_reset") return t("An administrator turned off two-step sign-in for your account ({time}). Turn it on again under Account.", { time });
  return t("New sign-in: {device}, {time}. Not you? Review devices.", { device, time });
}

/** "Active now", minutes or hours ago, or the date: for the device list. */
export function lastActive(sec: number, now = Date.now() / 1000): string {
  const m = Math.max(0, Math.round((now - sec) / 60));
  if (m < 2) return t("Active now");
  if (m < 60) return t("{n} minutes ago", { n: m });
  const h = Math.round(m / 60);
  if (h < 36) return h === 1 ? t("An hour ago") : t("{n} hours ago", { n: h });
  return new Date(sec * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

/** What the library's one banner shows (NoticeBanner.tsx): never a stack. One notice: its own sentence and action.
 *  Several sign-ins: one line counting them, with the newest. Several of mixed kinds: the most urgent one (two-step
 *  sign-in turned off, then a second step removed, then one added or new recovery codes, then a password used, then
 *  a sign-in) and how many more there are. "Dismiss all" takes all. */
export interface NoticeSummary {
  text: string;
  /** where its button leads; null: no button (the password is changed in the browser) */
  open: "devices" | "two-step" | null;
  ids: number[];
  /** more than one: the dismiss button says "Dismiss all" */
  many: boolean;
}

const URGENCY: Record<NoticeKind, number> = {
  "2fa_reset": 0, "2fa_off": 0, totp_removed: 1, passkey_removed: 1, totp_added: 2, passkey_added: 2, recovery_codes: 2, password_used: 3, sign_in: 4,
};
const opens = (k: NoticeKind): NoticeSummary["open"] => (k === "sign_in" ? "devices" : k === "2fa_reset" || isTwoStepChange(k) ? "two-step" : null);

/** list: as visibleNotices gives it, newest first. null when there is nothing to show. */
export function noticeSummary(list: readonly Notice[]): NoticeSummary | null {
  if (!list.length) return null;
  const ids = list.map((n) => n.id);
  if (list.length === 1) return { text: noticeText(list[0]), open: opens(list[0].kind), ids, many: false };
  if (list.every((n) => n.kind === "sign_in")) {
    const n = list[0];
    return {
      text: t("{n} new sign-ins (latest: {device}, {time}). Not you? Review devices.", { n: list.length, device: n.device || t("an unknown device"), time: noticeTime(n.at) }),
      open: "devices", ids, many: true,
    };
  }
  const top = [...list].sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || b.at - a.at || b.id - a.id)[0];
  const rest = list.length - 1;
  const more = rest === 1 ? t("1 more notice.") : t("{n} more notices.", { n: rest });
  // a mixed list with sign-ins and no button of its own (a password used): the devices are what to look at
  const open = opens(top.kind) ?? (list.some((n) => n.kind === "sign_in") ? "devices" : null);
  return { text: `${noticeText(top)} ${more}`, open, ids, many: true };
}
