// Two-step sign-in, the parts without React Native: reading the server's answers and tidying what the person types.
// The server's contract is server/twofactor.go; the screens are app/signin.tsx and app/two-step.tsx, and the second
// step of a change to the account (SecondStep.tsx: two-step sign-in, deleting the account).
import { t } from "./i18n";

/** What a failed request carries (ApiError in api.ts): read by shape, so this module needs no native code. */
interface Failed { status?: number; code?: string; body?: unknown }

/** The pending token when the password was right but the account wants a code next; else null. */
export function pendingToken(e: unknown): string | null {
  const f = e as Failed | null;
  if (!f || f.status !== 401 || f.code !== "two_factor_required") return null;
  const p = (f.body as { pending?: unknown } | null)?.pending;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Why a code or passkey was refused: wrong (try again), expired (the password is needed again), or anything else. */
export function codeProblem(e: unknown): "wrong" | "expired" | "other" {
  const f = e as Failed | null;
  if (f?.code === "wrong_code" || f?.code === "wrong_passkey") return "wrong";
  if (f?.status === 401 && f.code === "two_factor_expired") return "expired";
  return "other";
}

/** A code as typed: an authenticator code keeps its digits only; a recovery code keeps letters, digits and dashes. */
export function cleanCode(s: string, recovery: boolean): string {
  return recovery ? s.trim().replace(/[^0-9A-Za-z-]/g, "") : s.replace(/\D/g, "").slice(0, 6);
}

/** Whether the code is complete enough to send. */
export function codeReady(s: string, recovery: boolean): boolean {
  return recovery ? s.replace(/-/g, "").length === 16 : /^\d{6}$/.test(s);
}

/** The secret for typing into an authenticator by hand: groups of four. */
export const groupSecret = (s: string): string => (s.match(/.{1,4}/g) ?? []).join(" ");

/** Which second steps the password step said the account has: an authenticator app, a passkey for this server. An
 *  older server says neither: then the code is asked for, as before. */
export function methods(e: unknown): { totp: boolean; passkey: boolean } {
  const b = (e as Failed | null)?.body as { totp?: unknown; passkey?: unknown } | null;
  if (!b || (typeof b.totp !== "boolean" && typeof b.passkey !== "boolean")) return { totp: true, passkey: false };
  return { totp: b.totp === true, passkey: b.passkey === true };
}

/** The way the code step starts: the passkey when the account has one and the phone can use it and there's no app,
 *  else the app's code, else (a passkey this phone can't use) a recovery code. */
export function firstWay(has: { totp: boolean; passkey: boolean }, phoneCanPasskey: boolean): "passkey" | "code" | "recovery" {
  if (has.passkey && phoneCanPasskey && !has.totp) return "passkey";
  return has.totp || !has.passkey ? "code" : "recovery";
}

/** Why Android's passkey dialog ended without a passkey (Passkeys.kt's codes): the person closed it, the phone has
 *  none for this server, the phone is too old, Android couldn't check the server (its assetlinks.json isn't reachable,
 *  or the app isn't listed there), or something else. */
export function passkeyTrouble(e: unknown): "cancelled" | "none" | "unsupported" | "server" | "other" {
  const f = e as { code?: string; message?: string } | null;
  if (f?.code === "ERR_PASSKEY_CANCELLED") return "cancelled";
  if (f?.code === "ERR_PASSKEY_NONE") return "none";
  if (f?.code === "ERR_PASSKEY_UNSUPPORTED") return "unsupported";
  if (f?.code === "ERR_PASSKEY" && /rp ?id|relying party|domain|asset ?links|digital asset|cannot be validated|not associated/i.test(f.message ?? "")) return "server";
  if ((f as Failed | null)?.code === "passkeys_unavailable") return "server";
  return "other";
}

/** A second step as sent with a change that needs one while two-step sign-in is on: a code as typed (from the
 *  authenticator app, or a recovery code), or a passkey's answer to the session's challenge. */
export interface Step { code?: string; passkey?: Record<string, unknown> }

/** What the account offers as a second step here: the authenticator app, a passkey this phone can use. */
export interface Ways { totp: boolean; passkey: boolean }

/** The request body with the second step added: only what was given (an empty code is left out, the passkey wins). */
export function withStep<T extends object>(body: T, step?: Step | null): T & Step {
  const out: T & Step = { ...body };
  if (step?.passkey) out.passkey = step.passkey;
  else if (step?.code && step.code.trim()) out.code = step.code.trim();
  return out;
}

/** The server wants a second step for this change: two-step sign-in is on, though the app thought it was off. */
export function stepNeeded(e: unknown): boolean {
  const f = e as Failed | null;
  return f?.status === 403 && f.code === "second_step_required";
}

/** A recovery code is typed: chosen, or the only way left (no app, and no passkey this phone can use). */
export const usesRecovery = (ways: Ways, chosen: boolean): boolean => chosen || (!ways.totp && !ways.passkey);

/** Which buttons the second step offers: the passkey (unless a recovery code is typed), and the one that sends the code. */
export function stepButtons(ways: Ways, chosenRecovery: boolean): { passkey: boolean; code: boolean } {
  const recovery = usesRecovery(ways, chosenRecovery);
  return { passkey: ways.passkey && !recovery, code: recovery || ways.totp };
}

/** A refused second step in plain words; anything else as it came. */
export function stepError(e: unknown): unknown {
  const f = e as Failed | null;
  if (f?.code === "wrong_code") return new Error(t("That code isn't right. Try again."));
  if (f?.code === "wrong_passkey") return new Error(t("That passkey wasn't accepted. Try again."));
  if (stepNeeded(e)) return new Error(t("Your account uses two-step sign-in: confirm with a second step too."));
  return e;
}
