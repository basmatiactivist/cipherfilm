// Two-step sign-in, the parts without React Native: reading the server's answers and tidying what the person types.
// The server's contract is server/twofactor.go; the screens are app/signin.tsx and app/two-step.tsx.

/** What a failed request carries (ApiError in api.ts): read by shape, so this module needs no native code. */
interface Failed { status?: number; code?: string; body?: unknown }

/** The pending token when the password was right but the account wants a code next; else null. */
export function pendingToken(e: unknown): string | null {
  const f = e as Failed | null;
  if (!f || f.status !== 401 || f.code !== "two_factor_required") return null;
  const p = (f.body as { pending?: unknown } | null)?.pending;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Why a code was refused: wrong (try again), expired (the password is needed again), or anything else. */
export function codeProblem(e: unknown): "wrong" | "expired" | "other" {
  const f = e as Failed | null;
  if (f?.code === "wrong_code") return "wrong";
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
