import { useSyncExternalStore } from "react";
import { loadAlbums, type Album } from "./albums";
import { onWipe, session } from "./session";

// The decrypted album list, shared by the album overview and the album screens; forgotten at every lock or sign-out.
let albums: Album[] | null = null;
let error: string | undefined;
let loading = false;
let owner = "";
const subs = new Set<() => void>();
let snap: { albums: Album[] | null; error?: string; loading: boolean } = { albums, error, loading };
const emit = () => { snap = { albums: owner === session().me?.user.id ? albums : null, error, loading }; subs.forEach((f) => f()); };

export const useAlbums = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);

export async function refreshAlbums() {
  if (loading) return;
  loading = true; error = undefined; emit();
  const forUser = session().me?.user.id ?? "";
  try {
    const list = (await loadAlbums()).filter((a) => !a.broken).sort((x, y) => x.name.localeCompare(y.name));
    if (session().me?.user.id !== forUser || !session().masterKey) return;
    albums = list;
    owner = forUser;
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't load your albums.";
  } finally {
    loading = false; emit();
  }
}

export function forgetAlbums() { albums = null; owner = ""; error = undefined; emit(); }
onWipe(() => forgetAlbums());
