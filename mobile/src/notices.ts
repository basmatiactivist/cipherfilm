// Notices: what the server asks every other device of the account to show once (server/notices.go): a new sign-in,
// an administrator turning two-step sign-in off, or the password used for a sign-in that wasn't finished (no right
// code followed). This part has no React Native: it checks what arrived, keeps only
// kinds it knows, and words them. The store (noticesStore.ts) fetches and dismisses.
import { locale, t } from "./i18n";

export type NoticeKind = "sign_in" | "2fa_reset" | "password_used";
export interface Notice { id: number; kind: NoticeKind; device: string; at: number }
const KINDS = new Set<string>(["sign_in", "2fa_reset", "password_used"]);

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
  // the password is changed in the browser (Account says so)
  if (n.kind === "password_used") return t("Your password was used to start a sign-in that wasn't finished ({time}). Not you? Change your password in Cipherfilm in the browser.", { time });
  if (n.kind === "2fa_reset") return t("An administrator turned off two-step sign-in for your account ({time}). Turn it on again under Account.", { time });
  return t("New sign-in: {device}, {time}. Not you? Review devices.", { device: n.device || t("an unknown device"), time });
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
 *  sign-in turned off, then a password used, then a sign-in) and how many more there are. "Dismiss all" takes all. */
export interface NoticeSummary {
  text: string;
  /** where its button leads; null: no button (the password is changed in the browser) */
  open: "devices" | "two-step" | null;
  ids: number[];
  /** more than one: the dismiss button says "Dismiss all" */
  many: boolean;
}

const URGENCY: Record<NoticeKind, number> = { "2fa_reset": 0, password_used: 1, sign_in: 2 };
const opens = (k: NoticeKind): NoticeSummary["open"] => (k === "sign_in" ? "devices" : k === "2fa_reset" ? "two-step" : null);

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
