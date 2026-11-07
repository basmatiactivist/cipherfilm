// What a live update (live.ts) loads again: only the lists the ping names, and only those this phone has loaded.
// The phone's own uploads ping it too; while they run, the list waits until they are done (as after a share).
import { api } from "./api";
import { coalesce, watchLive, type Topic } from "./live";
import { libraryItems, libraryLoaded, refreshLibrary } from "./libraryStore";
import { albumsLoaded, refreshAlbums } from "./albumsStore";
import { onUploadsIdle, uploadsRunning } from "./upload";
import { peopleChanged } from "./search/people";
import { startSearch, thisPhoneIndexes } from "./search/engine";

const trashViews = new Set<() => void>();
/** The trash screen, while it is open: called when the trash changed on another device. */
export const onTrashChanged = (f: () => void) => { trashViews.add(f); return () => { trashViews.delete(f); }; };

// the search index: entries another device made, at most every 30 s (an indexing Mac writes one per photo)
const INDEX_EVERY = 30_000;
let indexAt = 0;
let missed = false; // a ping for the library while uploads ran

export async function sync(what: Set<Topic>) {
  const jobs: Promise<unknown>[] = [];
  if (what.has("items")) {
    if (uploadsRunning() > 0) missed = true;
    else if (libraryLoaded()) jobs.push(refreshLibrary({ quiet: true }));
  }
  if (what.has("albums") && albumsLoaded()) jobs.push(refreshAlbums({ quiet: true }));
  if (what.has("trash")) trashViews.forEach((f) => f());
  if (what.has("people")) peopleChanged();
  // the phone that indexes made those entries itself; a library refresh pulls them as well (libraryStore.ts)
  if (what.has("index") && !what.has("items") && !thisPhoneIndexes() && Date.now() - indexAt > INDEX_EVERY && libraryItems().length) {
    indexAt = Date.now();
    startSearch(libraryItems()).catch(() => {});
  }
  await Promise.all(jobs);
}

let started = false;
/** Starts live updates (once, from the root layout); they run while the app is on screen and unlocked. */
export function startLiveSync() {
  if (started) return;
  started = true;
  const c = coalesce(sync, { gap: 2000 });
  onUploadsIdle(() => { if (missed) { missed = false; c.ping(["items"]); } });
  watchLive({ onChange: (what) => c.ping(what), probe: () => api("GET", "/api/me/usage") });
}
