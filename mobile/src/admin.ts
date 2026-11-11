// Administration (Account › Administration, admins only): the same API and the same capabilities as the web app's
// Admin area (web/src/screens.tsx). This part has no React Native: the requests, checks and wording, tested on their own.
// The server decides who may do what (server/handlers_admin.go, admin_ext.go): a non-admin gets "not found" from every
// /api/admin/ request, whatever this app shows. Invites need no crypto here: the invited person makes their keys when
// they open the link (web/src/screens.tsx Invite).
import { api, server } from "./api";
import { locale, t, tn } from "./i18n";

export interface AdminUser {
  id: string; email: string; role: string; status: string; created_at: number; last_login_at: number;
  quota_bytes: number; used_bytes: number; item_count: number; nsfw: boolean; two_factor?: boolean;
}
export interface AdminInvite { id: string; email: string; expires_at: number; quota_bytes: number }
export interface AuditEntry { at: number; actor: string; action: string; target: string; detail: string }
export interface BackupReport { backup_ok_at?: number; backup_failed_at?: number; backup_failed_in?: string }
export interface ServerStatus extends BackupReport {
  disk_free_bytes: number; disk_total_bytes: number; data_bytes: number; active_sessions: number;
  last_backup_at: number; uptime_seconds: number; version?: string;
}
export interface Accounts { users: AdminUser[]; invites: AdminInvite[]; default_quota_bytes: number }

/** Whether to offer Administration at all. Only a hint for the screen: the server checks every request itself, and
 *  never lets the public demo login administer, even if it is listed as an admin by mistake. */
export const isAdmin = (me: { user: { role: string }; demo?: boolean } | null | undefined): boolean =>
  !!me && me.user.role === "admin" && !me.demo;

/** A refused /api/admin/ request: the account is no admin (any more). The server answers "not found" for that. */
export const noAccess = (e: unknown): boolean => {
  const s = (e as { status?: number } | null)?.status;
  return s === 403 || s === 404;
};

/** The server's ids: 32 lowercase hex characters. Anything else never goes into a request path. */
const ID = /^[0-9a-f]{32}$/;
function path(base: string, id: string, rest = ""): string {
  if (!ID.test(id)) throw new Error(t("That couldn't be found. It may have been removed."));
  return `${base}/${id}${rest}`;
}

export const loadAccounts = () => api<Accounts>("GET", "/api/admin/users");
export const loadAudit = async () => (await api<{ entries: AuditEntry[] }>("GET", "/api/admin/audit")).entries;
export const loadStatus = () => api<ServerStatus>("GET", "/api/admin/status");

/** The link the invited person opens in the browser (the server's own address, as the web app makes it). */
export const inviteLink = (origin: string, token: string) => `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;

/** Creates an invite; gb as typed ("" = the server's default). The link is shown once: the server keeps only a hash. */
export async function createInvite(email: string, gb: string): Promise<{ link: string; email: string; expires_at: number }> {
  const quota = parseGB(gb, true);
  const r = await api<{ token: string; email: string; expires_at: number }>("POST", "/api/admin/invites", { email: email.trim(), ...(quota === undefined ? {} : { quota_bytes: quota }) });
  return { link: inviteLink(server(), r.token), email: r.email, expires_at: r.expires_at };
}
export const revokeInvite = async (id: string) => api("DELETE", path("/api/admin/invites", id));

type Patch = { status?: "active" | "disabled"; role?: "admin" | "user"; nsfw?: boolean; quota_bytes?: number };
const patch = async (id: string, p: Patch) => api("PATCH", path("/api/admin/users", id), p);
/** Disabling signs out all of that person's devices at once (the server does it). */
export const setEnabled = (id: string, on: boolean) => patch(id, { status: on ? "active" : "disabled" });
export const setAdmin = (id: string, on: boolean) => patch(id, { role: on ? "admin" : "user" });
export const setExplicit = (id: string, on: boolean) => patch(id, { nsfw: on });
export const setLimit = (id: string, bytes: number) => patch(id, { quota_bytes: bytes });
/** Deletes the account and everything it stored, on the server, right away. */
export const deleteUser = async (id: string) => api("DELETE", path("/api/admin/users", id));
/** For someone who lost their authenticator and recovery codes; their devices tell them (server/notices.go). */
export const resetTwoStep = async (id: string) => api("DELETE", path("/api/admin/users", id, "/2fa"));
export const setDefaultLimit = (bytes: number) => api("PATCH", "/api/admin/settings", { default_quota_bytes: bytes });

/** A storage limit as typed, in GB, to bytes. 0 = no limit. Empty is "not given" where that's allowed (an invite's
 *  limit: the default then), else an error, as is anything that isn't a number of 0 or more. */
export function parseGB(s: string, optional = false): number | undefined {
  const v = s.trim().replace(",", ".");
  if (v === "" && optional) return undefined;
  const n = Number(v);
  if (v === "" || !Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error(t("Enter the storage limit as a number of GB (0 means no limit)."));
  return Math.round(n * 1e9);
}

const num = (n: number, d: number) => n.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
/** Sizes as the web's Admin shows them: GB with one decimal, MB below. */
export function size(n: number): string {
  if (n >= 1e9) return `${num(n / 1e9, 1)} GB`;
  if (n >= 1e6) return `${num(n / 1e6, 0)} MB`;
  return n > 0 ? t("less than 1 MB") : "0 MB";
}
export const limitText = (bytes: number) => (bytes === 0 ? t("no limit") : size(bytes));

/** "1.2 GB of 5.0 GB · 120 items", or "… used, no limit". */
export function usageLine(u: Pick<AdminUser, "used_bytes" | "quota_bytes" | "item_count">): string {
  const items = tn(u.item_count, "{n} item", "{n} items");
  return (u.quota_bytes === 0 ? t("{used} used, no limit", { used: size(u.used_bytes) }) : t("{used} of {quota}", { used: size(u.used_bytes), quota: size(u.quota_bytes) })) + " · " + items;
}

/** When someone last signed in, in days, as on the web. */
export function lastSeen(ts: number, now = Date.now() / 1000): string {
  if (!ts) return t("never signed in");
  const d = Math.floor((now - ts) / 86400);
  return d <= 0 ? t("active today") : d === 1 ? t("active yesterday") : t("active {n} days ago", { n: d });
}

/** The short labels next to a name: role, a disabled account, explicit search, two-step sign-in. */
export function badges(u: AdminUser, explicitShown: boolean): string[] {
  return [
    u.role === "admin" ? t("admin") : t("user"),
    u.status === "active" ? "" : t("disabled"),
    explicitShown && u.nsfw ? t("explicit search") : "",
    u.two_factor ? t("two-step sign-in") : "",
  ].filter(Boolean);
}

/** What the people list says at the top: "3 people · 12.0 GB stored · 4,000 items". */
export function summaryLine(users: AdminUser[]): string {
  const stored = users.reduce((n, u) => n + u.used_bytes, 0), items = users.reduce((n, u) => n + u.item_count, 0);
  const people = tn(users.length, "{n} person", "{n} people");
  return t("{people} · {stored} stored · {items}", { people, stored: size(stored), items: tn(items, "{n} item", "{n} items") });
}

export const dateText = (sec: number) => new Date(sec * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
const when = (sec: number) => new Date(sec * 1000).toLocaleString(locale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function uptime(sec: number): string {
  if (sec >= 86400) return t("{n} days", { n: Math.floor(sec / 86400) });
  if (sec >= 3600) return t("{n} hours", { n: Math.floor(sec / 3600) });
  return t("{n} minutes", { n: Math.floor(sec / 60) });
}

const backupStale = 36 * 3600; // a nightly backup that hasn't succeeded for a day and a half has stopped

/** The off-site backup as the operator's backup tool last reported it (web/src/backup.ts); a problem is the warning. */
export function backupState(s: BackupReport, now = Date.now() / 1000): { text: string; problem?: string } {
  const ok = s.backup_ok_at ?? 0, failed = s.backup_failed_at ?? 0;
  if (!ok && !failed) return { text: t("Nothing reported. Your backup tool can report its result here with /app backup-report (docs/SELF-HOSTING.md).") };
  if (failed > ok) {
    const step = s.backup_failed_in === "snapshot" ? t("the database snapshot couldn't be written") : t("the backup tool couldn't save to the backup target");
    const last = ok ? t("Last successful one: {time}.", { time: when(ok) }) : t("None has succeeded yet.");
    const problem = t("The last off-site backup failed on {time}: {step}.", { time: when(failed), step }) + " " + last;
    return { text: problem, problem };
  }
  if (now - ok > backupStale) {
    const problem = t("No off-site backup since {time}. The backup has stopped or isn't reporting.", { time: when(ok) });
    return { text: problem, problem };
  }
  return { text: t("{time}, successful", { time: when(ok) }) };
}

/** A day heading for the activity list: Today, Yesterday, or the date. */
export function dayLabel(sec: number, now = Date.now()): string {
  const d = new Date(sec * 1000), today = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86400000);
  if (days === 0) return t("Today");
  if (days === 1) return t("Yesterday");
  return d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

export function byDay(list: AuditEntry[], now = Date.now()): [string, AuditEntry[]][] {
  const out: [string, AuditEntry[]][] = [];
  for (const a of list) {
    const day = dayLabel(a.at, now);
    if (out.length && out[out.length - 1][0] === day) out[out.length - 1][1].push(a);
    else out.push([day, [a]]);
  }
  return out;
}

export type ActIcon = "plus" | "user" | "x" | "shield" | "search" | "check" | "slash" | "trash" | "cloud" | "logout" | "key" | "info";

/** One activity entry as a sentence ("You made a@x.org an administrator"), as the web says it. */
export function describe(a: AuditEntry, myEmail: string): { icon: ActIcon; text: string; warn?: boolean } {
  const p = (e: string) => (e === myEmail ? t("you") : e === "server console" ? t("the server console") : e === "a deleted account" ? t("a deleted account") : e);
  const subject = (e: string) => (e === myEmail ? t("You") : e === "server console" ? t("The server console") : e === "a deleted account" ? t("A deleted account") : e);
  const who = subject(a.actor);
  const v = { who, target: p(a.target) };
  switch (a.action) {
    case "invited": return { icon: "plus", text: t("{who} invited {target}", v) };
    case "joined": return { icon: "user", text: t("{target} joined", { target: subject(a.target) }) };
    case "invite revoked": return { icon: "x", text: t("{who} withdrew the invite for {target}", v) };
    case "role changed": return { icon: "shield", text: a.detail === "admin" ? t("{who} made {target} an administrator", v) : t("{who} made {target} a regular user", v) };
    case "explicit search allowed": return { icon: "search", text: t("{who} allowed explicit search for {target}", v) };
    case "explicit search turned off": return { icon: "search", text: t("{who} turned off explicit search for {target}", v) };
    case "enabled": return { icon: "check", text: t("{who} enabled {target}", v) };
    case "disabled": return { icon: "slash", text: t("{who} disabled {target}", v), warn: true };
    case "deleted": return { icon: "trash", text: t("{who} deleted {target} and everything they stored", v), warn: true };
    case "storage limit changed": return { icon: "cloud", text: t("{who} set the storage limit of {target} to {limit}", { ...v, limit: limitText(Number(a.detail)) }) };
    case "default limit changed": return { icon: "cloud", text: t("{who} set the default storage limit to {limit}", { who, limit: limitText(Number(a.detail)) }) };
    case "signed out a device": return { icon: "logout", text: a.detail ? t("{who} signed out {device}", { who, device: a.detail }) : t("{who} signed out a device", { who }) };
    case "signed out other devices": return { icon: "logout", text: t("{who} signed out all other devices", { who }) };
    case "two-step sign-in turned off": return { icon: "key", text: t("{who} turned off two-step sign-in for {target}", v), warn: true };
    case "turned on two-step sign-in": return { icon: "key", text: t("{who} turned on two-step sign-in", { who }) };
    case "turned off two-step sign-in": return { icon: "key", text: t("{who} turned off two-step sign-in", { who }) };
    case "made new recovery codes": return { icon: "key", text: t("{who} made new recovery codes", { who }) };
    case "signed out every device": return a.detail
      ? { icon: "logout", text: t("{who} signed out every device of {target}, and they delete what they keep", v), warn: true }
      : { icon: "logout", text: t("{who} signed out every device of {target}", v) };
  }
  // an action a newer server knows: shown as it is, in English
  return { icon: "info", text: [who, a.action, a.target ? `· ${p(a.target)}` : "", a.detail ? `(${a.detail})` : ""].filter(Boolean).join(" ") };
}
