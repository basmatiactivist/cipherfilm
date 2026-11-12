// Notices: what the server asks every other device of the account to show once (server/notices.go): a new sign-in,
// an administrator turning two-step sign-in off, the password used for a sign-in that wasn't finished (no right
// code followed), or a change to two-step sign-in made on another device (an authenticator app or a passkey added or
// removed, new recovery codes, turned off). They are listed behind the bell next to Account (app/notices.tsx), which
// shows how many are unread. This part has no React Native: it checks what arrived, keeps only kinds it knows, and
// words them. The store (noticesStore.ts) fetches, dismisses and remembers what was read.
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

/** A device's label as the server keeps it ("Chrome on macOS", "Pixel 8 (Android app)", "Upload tool"), in the
 *  phone's language. Anything else stays as it is. */
export function deviceLabel(d: string): string {
  const app = /^(.*) \((Android app|Mac app)\)$/.exec(d);
  if (app) return `${app[1]} (${t(app[2])})`;
  const on = /^(Chrome|Firefox|Safari|Edge) on (Android|iPhone|iPad|macOS|Windows|Linux)$/.exec(d);
  if (on) return t("{browser} on {os}", { browser: on[1], os: on[2] });
  if (d === "Upload tool" || d === "Android app" || d === "Mac app") return t(d);
  return d;
}

export function noticeText(n: Notice): string {
  const time = noticeTime(n.at);
  const device = n.device ? deviceLabel(n.device) : t("an unknown device");
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

/** Where a notice's button leads in the notifications list (app/notices.tsx); null: no button (the password is
 *  changed in the browser). */
export const noticeOpens = (k: NoticeKind): "devices" | "two-step" | null =>
  (k === "sign_in" ? "devices" : k === "2fa_reset" || isTwoStepChange(k) ? "two-step" : null);

/** How many of the notices are newer than the last one the person saw in the list (the bell's badge). */
export const unreadCount = (list: readonly Notice[], lastRead: number): number => list.filter((n) => n.id > lastRead).length;
