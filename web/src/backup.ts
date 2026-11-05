// What the nightly off-site backup last reported (scripts/kopia-snapshot.sh), for Admin > Server.
export interface BackupReport { backup_ok_at?: number; backup_failed_at?: number; backup_failed_in?: string }

const backupStale = 36 * 3600; // a nightly backup that hasn't succeeded for a day and a half has stopped

/** The off-site backup as the nightly run last reported it (scripts/kopia-snapshot.sh); a problem is the warning text. */
export function backupState(s: BackupReport, now = Date.now() / 1000): { text: string; problem?: string } {
  const ok = s.backup_ok_at ?? 0, failed = s.backup_failed_at ?? 0;
  const when = (ts: number) => new Date(ts * 1000).toLocaleString();
  if (!ok && !failed) return { text: "Not set up. Nightly off-site backups with Kopia report here (docs/BACKUP-KOPIA.md)." };
  if (failed > ok) {
    const step = s.backup_failed_in === "snapshot" ? "the database snapshot couldn't be written" : "Kopia couldn't save to the backup target";
    const problem = `The last off-site backup failed on ${when(failed)}: ${step}. ${ok ? `Last successful one: ${when(ok)}.` : "None has succeeded yet."}`;
    return { text: problem, problem };
  }
  if (now - ok > backupStale) {
    const problem = `No off-site backup since ${when(ok)}. The nightly run has stopped or isn't reporting.`;
    return { text: problem, problem };
  }
  return { text: `${when(ok)}, successful` };
}
