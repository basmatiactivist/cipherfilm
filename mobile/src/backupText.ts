// What the Backup screen says about the backup, in each state: plain functions, so every state can be checked in a
// test. A phone where backup was never set up has backed up nothing yet: nothing here may sound as if photos went
// missing ("not in Cipherfilm", "not backed up") before the person chose what to back up.
import { fmtSpeed, type LiveProgress } from "./backupProgress";

const items = (n: number) => (n === 1 ? "1 photo or video" : `${n} photos and videos`);

/** The line under "Back up automatically". */
export function headline(s: {
  on: boolean; running: boolean; live: LiveProgress | null; waiting: number | null;
  includeExisting: boolean; older: number; partial: boolean;
}): string {
  if (!s.on) return "Off";
  if (s.running) return s.live ? `Backing up ${s.live.position} of ${s.live.total}` : "Backing up…";
  if (s.waiting) return `${items(s.waiting)} waiting`;
  // "only new ones" with older ones not in the library: what was chosen is done, but not "everything"
  if (!s.includeExisting && s.older) return "Up to date. New photos and videos are backed up as they come.";
  return s.partial ? "Everything Cipherfilm can see is backed up" : "Everything is backed up";
}

/** While a run uploads: how fast, and how many are left. */
export function liveLine(live: LiveProgress): string {
  const left = live.left === 1 ? "1 left" : `${live.left} left`;
  return live.speed ? `${fmtSpeed(live.speed)} · ${left}` : left;
}

/**
 * The choice for what is already in the chosen folders. inFolders: how many photos and videos the chosen folders hold
 * now (for a backup not set up yet); older: of those from before the backup's start there, how many the library
 * doesn't have (for a backup that is on with "only new ones").
 */
export function existingChoice(s: { on: boolean; includeExisting: boolean; inFolders: number; older: number }): { all: string; hint: string } {
  const skipped = "Photos and videos already in your library (same name and size) are skipped, so nothing is uploaded twice.";
  if (!s.on) {
    return {
      all: s.inFolders ? `Also the ${items(s.inFolders)} already in these folders` : "Also the ones already in these folders",
      hint: `Applies to all chosen folders. ${skipped}`,
    };
  }
  if (s.includeExisting) return { all: "Also the ones already in these folders", hint: `Applies to all chosen folders. ${skipped}` };
  if (s.older) {
    return {
      all: s.older === 1 ? "Also the 1 older one that isn't in your library yet" : `Also the ${s.older} older ones that aren't in your library yet`,
      hint: "Applies to all chosen folders. The older ones already in your library are skipped.",
    };
  }
  return { all: "Also the ones already in these folders", hint: "Applies to all chosen folders. The older ones in these folders are already in your library." };
}

/** A folder in the list: where it is and how much it holds. */
export const folderLine = (path: string, count: number) => `${path.replace(/\/$/, "")} · ${items(count)}`;

/** Files too large for the background (the Google Play build's automatic runs). */
export function tooLarge(waiting: { name: string }[]): string {
  return waiting.length === 1
    ? `${waiting[0].name} is too large to upload in the background. Tap Back up now to upload it.`
    : `${waiting.length} videos are too large to upload in the background. Tap Back up now to upload them.`;
}

/** The small line at the end of the card: when it last ran, and how many it has backed up from this phone. */
export function lastLine(st: { lastDone?: number; lastRun?: number; uploaded: number }, fmt: (t: number) => string): string {
  const when = st.lastDone ? `Last complete: ${fmt(st.lastDone)}` : st.lastRun ? `Last checked: ${fmt(st.lastRun)}` : "Not run yet";
  return st.uploaded ? `${when} · ${items(st.uploaded)} backed up from this phone` : when;
}
