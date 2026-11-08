// What the Backup screen says about the backup, in each state: plain functions, so every state can be checked in a
// test. A phone where backup was never set up has backed up nothing yet: nothing here may sound as if photos went
// missing ("not in Cipherfilm", "not backed up") before the person chose what to back up.
import { fmtSpeed, type LiveProgress } from "./backupProgress";
import { t, tn } from "./i18n";

// the number as it is (no grouping), as before the translation
const items = (n: number) => tn(n, "{n} photo or video", "{n} photos and videos", { n });

/** The line under "Back up automatically". */
export function headline(s: {
  on: boolean; running: boolean; live: LiveProgress | null; waiting: number | null;
  includeExisting: boolean; older: number; partial: boolean;
}): string {
  if (!s.on) return t("Off");
  if (s.running) return s.live ? t("Backing up {n} of {total}", { n: s.live.position, total: s.live.total }) : t("Backing up…");
  if (s.waiting) return tn(s.waiting, "{n} photo or video waiting", "{n} photos and videos waiting", { n: s.waiting });
  // "only new ones" with older ones not in the library: what was chosen is done, but not "everything"
  if (!s.includeExisting && s.older) return t("Up to date. New photos and videos are backed up as they come.");
  return s.partial ? t("Everything Cipherfilm can see is backed up") : t("Everything is backed up");
}

/** While a run uploads: how fast, and how many are left. */
export function liveLine(live: LiveProgress): string {
  const left = tn(live.left, "{n} left", "{n} left", { n: live.left });
  return live.speed ? `${fmtSpeed(live.speed)} · ${left}` : left;
}

/**
 * The choice for what is already in the chosen folders. inFolders: how many photos and videos the chosen folders hold
 * now (for a backup not set up yet); older: of those from before the backup's start there, how many the library
 * doesn't have (for a backup that is on with "only new ones").
 */
export function existingChoice(s: { on: boolean; includeExisting: boolean; inFolders: number; older: number }): { all: string; hint: string } {
  const hint = t("Applies to all chosen folders. Photos and videos already in your library (same name and size) are skipped, so nothing is uploaded twice.");
  if (!s.on) {
    return {
      all: s.inFolders ? tn(s.inFolders, "Also the {n} photo or video already in these folders", "Also the {n} photos and videos already in these folders", { n: s.inFolders }) : t("Also the ones already in these folders"),
      hint,
    };
  }
  if (s.includeExisting) return { all: t("Also the ones already in these folders"), hint };
  if (s.older) {
    return {
      all: tn(s.older, "Also the {n} older one that isn't in your library yet", "Also the {n} older ones that aren't in your library yet", { n: s.older }),
      hint: t("Applies to all chosen folders. The older ones already in your library are skipped."),
    };
  }
  return { all: t("Also the ones already in these folders"), hint: t("Applies to all chosen folders. The older ones in these folders are already in your library.") };
}

/** A folder in the list: where it is and how much it holds. */
export const folderLine = (path: string, count: number) => `${path.replace(/\/$/, "")} · ${items(count)}`;

/** Files too large for the background (the Google Play build's automatic runs). */
export function tooLarge(waiting: { name: string }[]): string {
  return waiting.length === 1
    ? t("{name} is too large to upload in the background. Tap Back up now to upload it.", { name: waiting[0].name })
    : t("{n} videos are too large to upload in the background. Tap Back up now to upload them.", { n: waiting.length });
}

/** The small line at the end of the card: when it last ran, and how many it has backed up from this phone. */
export function lastLine(st: { lastDone?: number; lastRun?: number; uploaded: number }, fmt: (t: number) => string): string {
  const when = st.lastDone ? t("Last complete: {when}", { when: fmt(st.lastDone) }) : st.lastRun ? t("Last checked: {when}", { when: fmt(st.lastRun) }) : t("Not run yet");
  return st.uploaded ? `${when} · ${tn(st.uploaded, "{n} photo or video backed up from this phone", "{n} photos and videos backed up from this phone", { n: st.uploaded })}` : when;
}
