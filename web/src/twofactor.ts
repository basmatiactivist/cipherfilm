// Two-step sign-in (docs/THREAT_MODEL.md, "Two-step sign-in"): after the password, a new sign-in needs a code from an
// authenticator app or one of ten recovery codes. Unlocking a browser that is already signed in never needs one.
import { api } from "./api";
import { encodeQR, qrPath } from "./crypto/qr";

export interface TwoFactorStatus { enabled: boolean; recovery_codes_left: number; available: boolean }
export interface TwoFactorSetup { secret: string; uri: string }

export const status = () => api<TwoFactorStatus>("GET", "/api/me/2fa");
/** Makes a new secret (needs the password proof); two-step sign-in is on only after enable() with a code from it. */
export const setup = (currentAuth: string) => api<TwoFactorSetup>("POST", "/api/me/2fa/setup", { current_auth: currentAuth });
export const enable = async (code: string) => (await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/enable", { code: cleanCode(code) })).recovery_codes;
export const disable = (currentAuth: string, code: string) => api("POST", "/api/me/2fa/disable", { current_auth: currentAuth, code: code.trim() });
export const newCodes = async (currentAuth: string, code: string) =>
  (await api<{ recovery_codes: string[] }>("POST", "/api/me/2fa/recovery-codes", { current_auth: currentAuth, code: code.trim() })).recovery_codes;

/** A 6-digit code as typed: spaces and dashes go ("123 456"). */
export const cleanCode = (s: string): string => s.replace(/[\s-]/g, "");
/** Whether what was typed can be sent: 6 digits, or (recovery) the 16 characters of a recovery code with any dashes. */
export function codeReady(s: string, recovery: boolean): boolean {
  const c = cleanCode(s);
  return recovery ? /^[0-9a-z]{16}$/i.test(c) : /^\d{6}$/.test(c);
}
/** The secret in groups of four, as people type it into an authenticator app. */
export const groupSecret = (s: string): string => s.replace(/(.{4})(?=.)/g, "$1 ");

/** The QR code of the otpauth:// address, drawn here (never by a QR service): an SVG path and its size. */
export function qrFor(uri: string): { d: string; size: number } {
  const q = encodeQR(uri);
  return { d: qrPath(q, 4), size: q.size + 8 };
}

/** What the recovery codes file says. */
export const codesFile = (email: string, codes: string[]): string =>
  `Cipherfilm recovery codes for ${email}\n\n${codes.join("\n")}\n\nEach code signs in once instead of a code from your authenticator app.\nKeep them somewhere safe and private.\n`;
