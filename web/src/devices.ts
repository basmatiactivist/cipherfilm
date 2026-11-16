/** Signing out devices that go unused (server/sessions.go idleLimit): the account's choice of 7, 14 or 30 days. A device
 *  unused for longer is signed out the next time it connects, and deletes what it keeps of the library; "Sign out
 *  unused devices now" does it at once. */

export const IDLE_CHOICES = [7, 14, 30] as const;
export const IDLE_DEFAULT = 30;

export interface SessionLike { current: boolean; last_seen: number }

/** The account's choice as the server sent it, or the default for anything else (an older server sends none). */
export const idleDaysOf = (v: unknown): number => (IDLE_CHOICES as readonly number[]).includes(v as number) ? (v as number) : IDLE_DEFAULT;

/** The other devices unused for longer than the limit: the ones "Sign out unused devices now" ends (never this one). */
export const unusedDevices = <T extends SessionLike>(list: T[], idleDays: number, nowSec: number): T[] =>
  list.filter((d) => !d.current && nowSec - d.last_seen > idleDays * 86400);

export const idleLabel = (days: number) => `${days} days`;

export const unusedButton = (n: number) => n === 1 ? "Sign out 1 unused device" : `Sign out ${n} unused devices`;
