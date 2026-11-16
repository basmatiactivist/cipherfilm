// Devices that go unused are signed out (server/sessions.go idleLimit): after the account's choice of 7, 14 or 30 days
// without a request. Such a device is signed out as from another one, so it deletes what it keeps of the library when
// it comes back; "Sign out unused devices now" ends them at once. And the last-upload time of this phone's session,
// which the server only records since the storage overview came: the app sends the newest upload it knows once.
// Plain logic only (tested without the phone); the screen is app/devices.tsx, the sending lastUploadSend.ts.

export const IDLE_CHOICES = [7, 14, 30] as const;
export const IDLE_DEFAULT = 30;

/** The account's choice as the server sent it, or the default for anything else (an older server sends none). */
export const idleDaysOf = (v: unknown): number => (IDLE_CHOICES as readonly number[]).includes(v as number) ? (v as number) : IDLE_DEFAULT;

/** The other devices unused for longer than the limit: the ones "Sign out unused devices now" ends (never this one). */
export const unusedDevices = <T extends { current: boolean; last_seen: number }>(list: T[], idleDays: number, nowSec: number): T[] =>
  list.filter((d) => !d.current && nowSec - d.last_seen > idleDays * 86400);

/** The newest time (seconds, the server's) this phone uploaded something it still finds in the library: an item's
 *  created_at is when its upload began on the server. 0 when there is none. */
export function newestOwnUpload(items: { id: string; created_at: number }[], own: { has(id: string): boolean }): number {
  let newest = 0;
  for (const it of items) if (own.has(it.id) && Number.isFinite(it.created_at) && it.created_at > newest) newest = it.created_at;
  return newest;
}

export interface LastUploadDeps {
  sessionId?: string;
  demo?: boolean;
  /** the session this phone already sent its last upload for, if any */
  sentFor: () => Promise<string | undefined>;
  markSent: (sessionId: string) => Promise<void>;
  /** the newest own upload in seconds, 0 for none */
  newest: () => Promise<number>;
  post: (at: number) => Promise<unknown>;
}

/** Sends the newest upload time once per session: not for the demo, not again for a session already done, nothing when
 *  this phone knows of no upload. The server keeps it only if it has none for the session, so a lost answer is
 *  harmless to send again. */
export async function sendLastUpload(d: LastUploadDeps): Promise<"sent" | "done" | "none"> {
  if (d.demo || !d.sessionId) return "done";
  if ((await d.sentFor()) === d.sessionId) return "done";
  const at = Math.floor(await d.newest());
  if (!(at > 0)) return "none";
  await d.post(at);
  await d.markSent(d.sessionId);
  return "sent";
}
