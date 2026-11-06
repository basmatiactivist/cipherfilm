import { useSyncExternalStore } from "react";
import { loadAlbums, type Album } from "./albums";
import { onWipe, session } from "./session";

// The decrypted album list, shared by the album overview and the album screens; forgotten at every lock or sign-out.
let albums: Album[] | null = null;
let error: string | undefined;
let loading = false;
let owner = "";
// bumped whenever the list is forgotten (every lock): a load still running then ends quietly, as in libraryStore.ts
let gen = 0;
const subs = new Set<() => void>();
let snap: { albums: Album[] | null; error?: string; loading: boolean } = { albums, error, loading };
const emit = () => { snap = { albums: owner === session().me?.user.id ? albums : null, error, loading }; subs.forEach((f) => f()); };

export const useAlbums = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);

export async function refreshAlbums() {
  if (loading) return;
  const mine = gen;
  loading = true; error = undefined; emit();
  const forUser = session().me?.user.id ?? "";
  const current = () => mine === gen && session().me?.user.id === forUser && !!session().masterKey;
  try {
    const list = (await loadAlbums()).filter((a) => !a.broken).sort((x, y) => x.name.localeCompare(y.name));
    if (!current()) return;
    albums = list;
    owner = forUser;
  } catch (e) {
    if (current()) error = e instanceof Error ? e.message : "Couldn't load your albums.";
  } finally {
    if (mine === gen) { loading = false; emit(); }
  }
}

export function forgetAlbums() { albums = null; owner = ""; error = undefined; loading = false; gen++; emit(); }
onWipe(() => forgetAlbums());
