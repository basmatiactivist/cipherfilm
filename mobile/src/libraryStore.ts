import { useSyncExternalStore } from "react";
import { loadCachedLibrary, loadLibrary, prefetchThumbs, pruneCache, type Item } from "./library";
import { onWipe, session } from "./session";
import { rememberLibrary } from "./backup";
import { startSearch } from "./search/engine";
import { api } from "./api";

// One copy of the decrypted list for the library and the viewer; reloaded after uploads.
let items: Item[] | null = null;
let error: string | undefined;
let loading = false;
const subs = new Set<() => void>();
let snap: { items: Item[] | null; error?: string; loading: boolean } = { items, error, loading };
const emit = () => { snap = { items, error, loading }; subs.forEach((f) => f()); };

export const useLibrary = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);
export const libraryItems = () => (items && owner === session().me?.user.id && session().masterKey ? items : []);

let owner = ""; // the account the list was decrypted for

export async function refreshLibrary() {
  if (loading) return;
  loading = true; error = undefined; emit();
  const forUser = session().me?.user.id ?? "";
  const current = () => session().me?.user.id === forUser && !!session().masterKey;
  try {
    // the list from the last visit first, so the grid is there at once; the server's list replaces it
    if (!items || owner !== forUser) {
      const cached = await loadCachedLibrary();
      if (cached && current() && (!items || owner !== forUser)) { items = cached; owner = forUser; emit(); }
      // (not shown: its item keys are shared with the decrypted list, library.ts, and go with it at the next lock)
    }
    const list = await loadLibrary();
    // the session may have locked or changed while the list was loading: then it is not shown, and its keys go
    if (!current()) { list.forEach((i) => i.itemKey?.fill(0)); return; }
    items = list;
    owner = forUser;
    prefetchThumbs(list);
    setTimeout(() => pruneCache(new Set(list.map((i) => i.id))), 2000);
    // the rest waits until the grid is on screen and scrolling: both read the whole list on the JS thread
    setTimeout(() => {
      if (!current()) return;
      rememberLibrary(list).catch(() => {}); // the backup skips what is already here
      startSearch(list).catch(() => {}); // search: the index for what is new
    }, 1500);
  } catch (e) {
    error = e instanceof Error ? e.message : "Couldn't load your photos.";
  } finally {
    loading = false; emit();
  }
}

export function forgetLibrary() {
  items?.forEach((i) => i.itemKey?.fill(0)); // the unwrapped item keys leave memory with the list
  items = null; owner = ""; error = undefined; emit();
}

// a lock, sign-out or account change takes the decrypted list along
onWipe(() => forgetLibrary());

/** Marks items as favorites (or not) on the server and in the list on screen. */
export async function setFavorite(ids: string[], favorite: boolean) {
  for (let i = 0; i < ids.length; i += 500) await api("POST", "/api/items/favorite", { item_ids: ids.slice(i, i + 500), favorite });
  const set = new Set(ids);
  if (items) { items = items.map((i) => (set.has(i.id) ? { ...i, favorite } : i)); emit(); }
}
