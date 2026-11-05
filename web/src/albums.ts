import { api } from "./api";
import { getSodium, b64, unb64 } from "./crypto/sodium";
import { decryptAlbumName, encryptAlbumName } from "./crypto/item";
import { mem } from "./state";
import { inBatches } from "./items";

export interface Album { id: string; name: string; itemIds: string[]; created_at: number; broken?: boolean }

const need = () => {
  if (!mem.masterKey) throw new Error("Unlock your library first.");
  return mem.masterKey;
};
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
export const MAX_NAME = 100;

export async function loadAlbums(): Promise<Album[]> {
  const s = await getSodium();
  const master = need();
  const r = await api<{ albums: { id: string; name_enc: string; created_at: number; item_ids: string[] }[] }>("GET", "/api/albums");
  return r.albums.map((a) => {
    try {
      return { id: a.id, name: decryptAlbumName(s, unb64(s, a.name_enc), master, a.id), itemIds: a.item_ids, created_at: a.created_at };
    } catch {
      return { id: a.id, name: "Unreadable album", itemIds: a.item_ids, created_at: a.created_at, broken: true };
    }
  });
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
