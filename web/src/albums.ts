import { api } from "./api";
import { getSodium, b64, unb64, type Sodium } from "./crypto/sodium";
import { decryptAlbumName, encryptAlbumName } from "./crypto/item";
import { mem } from "./state";
import { inBatches } from "./items";
import { ListSync, type Page } from "./sync";

export interface Album { id: string; name: string; itemIds: string[]; created_at: number; broken?: boolean }

const need = () => {
  if (!mem.masterKey) throw new Error("Unlock your library first.");
  return mem.masterKey;
};
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
export const MAX_NAME = 100;

interface RawAlbum { id: string; name_enc: string; created_at: number; item_ids: string[] }

export function decryptAlbums(s: Sodium, master: Uint8Array, raw: RawAlbum[]): Album[] {
  return raw.map((a) => {
    try {
      return { id: a.id, name: decryptAlbumName(s, unb64(s, a.name_enc), master, a.id), itemIds: a.item_ids, created_at: a.created_at };
    } catch {
      return { id: a.id, name: "Unreadable album", itemIds: a.item_ids, created_at: a.created_at, broken: true };
    }
  });
}

// The album list, kept current with ?since like the library (sync.ts): after the whole list, a change asks the server
// only for the albums that changed (each whole) and those deleted. Its names are decrypted, so it goes at every lock
// and sign-out (forgetAlbums), and when the master key it was made with is no longer the one in use.
let sodium: Sodium | undefined;
let listKey: Uint8Array | null = null;
const albumOrder = (a: Album, b: Album) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const albums = new ListSync<Album>({
  path: "/api/albums",
  // the server's answers name the list "albums"; ListSync reads "items"
  get: async (p) => { const r = await api<Page & { albums?: RawAlbum[] }>("GET", p); return { ...r, items: r.albums ?? [] }; },
  decrypt: (raw) => decryptAlbums(sodium!, need(), raw as RawAlbum[]),
  order: albumOrder,
});

/** Drops the album list and its cursor: the next load is a whole one. */
export function forgetAlbums() { albums.forget(); listKey = null; }

export async function loadAlbums(): Promise<Album[]> {
  sodium = await getSodium();
  const master = need();
  if (listKey !== master) { albums.forget(); listKey = master; }
  return [...(await albums.load()).items];
}

export async function createAlbum(name: string): Promise<Album> {
  const s = await getSodium();
  const id = newId();
  const clean = name.trim().slice(0, MAX_NAME);
  await api("POST", "/api/albums", { id, name_enc: b64(s, encryptAlbumName(s, clean, need(), id)) });
  return { id, name: clean, itemIds: [], created_at: Math.floor(Date.now() / 1000) };
}

export async function renameAlbum(id: string, name: string): Promise<string> {
  const s = await getSodium();
  const clean = name.trim().slice(0, MAX_NAME);
  await api("PATCH", `/api/albums/${id}`, { name_enc: b64(s, encryptAlbumName(s, clean, need(), id)) });
  return clean;
}

export const deleteAlbum = (id: string) => api("DELETE", `/api/albums/${id}`);
export const addToAlbum = (id: string, itemIds: string[]) => inBatches(itemIds, (part) => api("PUT", `/api/albums/${id}/items`, { item_ids: part }));
export const removeFromAlbum = (id: string, itemId: string) => api("DELETE", `/api/albums/${id}/items/${itemId}`);
