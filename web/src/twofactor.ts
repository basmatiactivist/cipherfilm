// Two-step sign-in (docs/THREAT_MODEL.md, "Two-step sign-in"): after the password, a new sign-in needs a code from an
// authenticator app, a passkey (passkeys.ts) or one of ten recovery codes. Unlocking a browser that is already signed
// in never needs one.
import { api, ApiError } from "./api";
import { encodeQR, qrPath } from "./crypto/qr";
import type { Proof } from "./passkeys";

/** totp, passkeys: what the account has (an older server leaves them out: then "enabled" means the app). */
export interface TwoFactorStatus { enabled: boolean; recovery_codes_left: number; available: boolean; totp?: boolean; passkeys?: number }
export interface TwoFactorSetup { secret: string; uri: string }

export const status = () => api<TwoFactorStatus>("GET", "/api/me/2fa");
/** Makes a new secret (needs the password proof, and a second step while a passkey has two-step sign-in on); the app
 *  counts only after enable() with a code from it. */
export const setup = (proof: Proof) => api<TwoFactorSetup>("POST", "/api/me/2fa/setup", proof);
/** The recovery codes when the app is the account's first second step; null when it keeps the ones it has. */
export const enable = async (code: string) => (await api<{ recovery_codes?: string[] }>("POST", "/api/me/2fa/enable", { code: cleanCode(code) })).recovery_codes ?? null;
export const disable = (proof: Proof) => api("POST", "/api/me/2fa/disable", proof);
/** Removes the authenticator app, keeping the passkeys. */
export const removeApp = (proof: Proof) => api<{ two_factor: boolean }>("POST", "/api/me/2fa/totp/remove", proof);
export const newCodes = async (proof: Proof) => (await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/recovery-codes", proof)).recovery_codes;

// ---- the second step of a credential change ----

/** What changing the password, making a new recovery key or deleting the account sends besides the password while
 *  two-step sign-in is on: a code as typed (from the app, or a recovery code), or a passkey's answer. */
export interface SecondStep { code?: string; passkey?: Record<string, any> }

/** Only what was given: nothing at all for an account without two-step sign-in (an older server ignores it anyway). */
export function stepFields(s?: SecondStep): SecondStep {
  if (s?.passkey) return { passkey: s.passkey };
  const c = s?.code?.trim();
  return c ? { code: c } : {};
}

/** The server wants a second step the app didn't send (two-step sign-in was turned on elsewhere). */
export const needsStep = (e: unknown): boolean => e instanceof ApiError && e.status === 403 && e.code === "second_step_required";

/** The second step's refusals in plain words; anything else as it is. */
export function stepError(e: unknown): unknown {
  if (!(e instanceof ApiError) || e.status !== 403) return e;
  if (e.code === "second_step_required") return new Error("Your account uses two-step sign-in. Enter a code from your authenticator app or a recovery code, or use a passkey.");
  if (e.code === "wrong_code") return new Error("That code isn't right. Try the newest code from your app, or a recovery code.");
  if (e.code === "wrong_passkey") return new Error("That passkey wasn't accepted. Try again, or use a code.");
  return e;
}

/** Whether this is a phone or tablet: there the authenticator app is on the same device, so it is opened, not scanned. */
export const touchDevice = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** A 6-digit code as typed: spaces and dashes go ("123 456"). */
export const cleanCode = (s: string): string => s.replace(/[\s-]/g, "");
/** Whether what was typed can be sent: 6 digits, or (recovery) the 16 characters of a recovery code with any dashes. */
export function codeReady(s: string, recovery: boolean): boolean {
  const c = cleanCode(s);
  return recovery ? /^[0-9a-z]{16}$/i.test(c) : /^\d{6}$/.test(c);
}
/** The secret in groups of four, as people type it into an authenticator app. */
export const groupSecret = (s: string): string => s.replace(/(.{4})(?=.)/g, "$1 ");

/** Whether the server's address is an authenticator app's otpauth://totp/ address: only that is opened as a link (any
 *  other scheme, a web page or an app's own link, from a server that isn't honest, is not). */
export const totpUri = (uri: unknown): uri is string => typeof uri === "string" && uri.slice(0, 15).toLowerCase() === "otpauth://totp/";

/** The QR code of the otpauth:// address, drawn here (never by a QR service): an SVG path and its size. */
export function qrFor(uri: string): { d: string; size: number } {
  const q = encodeQR(uri);
  return { d: qrPath(q, 4), size: q.size + 8 };
}

/** What the recovery codes file says. */
export const codesFile = (email: string, codes: string[]): string =>
  `Cipherfilm recovery codes for ${email}\n\n${codes.join("\n")}\n\nEach code signs in once instead of a code from your authenticator app or a passkey.\nKeep them somewhere safe and private.\n`;
