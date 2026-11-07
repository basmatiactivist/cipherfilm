import { useSyncExternalStore } from "react";
import { loadAlbums, type Album } from "./albums";
import { onWipe, session } from "./session";

// The decrypted album list, shared by the album overview and the album screens; forgotten at every lock or sign-out.
let albums: Album[] | null = null;
let error: string | undefined;
let loading = false; // shown: the pull-to-refresh spinner
let busy = false; // a load runs (also a quiet one); one asked for meanwhile runs after it, as in libraryStore.ts
let again = false;
let owner = "";
// bumped whenever the list is forgotten (every lock): a load still running then ends quietly, as in libraryStore.ts
let gen = 0;
const subs = new Set<() => void>();
let snap: { albums: Album[] | null; error?: string; loading: boolean } = { albums, error, loading };
const emit = () => { snap = { albums: owner === session().me?.user.id ? albums : null, error, loading }; subs.forEach((f) => f()); };

export const useAlbums = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);

/** quiet: for live updates, without the spinner or an error banner (as refreshLibrary). */
export async function refreshAlbums(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet === true;
  if (busy) { again = true; if (!quiet && !loading) { loading = true; emit(); } return; }
  const mine = gen;
  busy = true;
  if (!quiet) { loading = true; error = undefined; emit(); }
  const forUser = session().me?.user.id ?? "";
  const current = () => mine === gen && session().me?.user.id === forUser && !!session().masterKey;
  try {
    const list = (await loadAlbums()).filter((a) => !a.broken).sort((x, y) => x.name.localeCompare(y.name));
    if (!current()) return;
    albums = list;
    owner = forUser;
    error = undefined;
  } catch (e) {
    if (current() && !quiet) error = e instanceof Error ? e.message : "Couldn't load your albums.";
  } finally {
    if (mine === gen) {
      busy = false; loading = false; emit();
      if (again) { again = false; refreshAlbums({ quiet: true }); }
    }
  }
}

/** Whether the albums were loaded for the account: only then does a live update load them again. */
export const albumsLoaded = () => busy || (albums !== null && owner === session().me?.user.id);

export function forgetAlbums() { albums = null; owner = ""; error = undefined; loading = false; busy = false; again = false; gen++; emit(); }
onWipe(() => forgetAlbums());
