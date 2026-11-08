// Albums as the web app keeps them: names encrypted under the master key, bound to the album id.
import { getSodium, b64, unb64 } from "@crypto/sodium";
import { decryptAlbumName, encryptAlbumName } from "@crypto/item";
import { api } from "./api";
import { session } from "./session";
import { t } from "./i18n";

export interface Album { id: string; name: string; itemIds: string[]; broken?: boolean }

const need = () => {
  const k = session().masterKey;
  if (!k) throw new Error(t("Unlock your library first."));
  return k;
};

export async function loadAlbums(): Promise<Album[]> {
  const s = await getSodium();
  const master = need();
  const r = await api<{ albums: { id: string; name_enc: string; item_ids: string[] }[] }>("GET", "/api/albums");
  return r.albums.map((a) => {
    try {
      return { id: a.id, name: decryptAlbumName(s, unb64(s, a.name_enc), master, a.id), itemIds: a.item_ids };
    } catch {
      return { id: a.id, name: t("Unreadable album"), itemIds: a.item_ids, broken: true };
    }
  });
}

export async function createAlbum(name: string): Promise<Album> {
  const s = await getSodium();
  const id = s.to_hex(s.randombytes_buf(16));
  const clean = name.trim().slice(0, 100);
  await api("POST", "/api/albums", { id, name_enc: b64(s, encryptAlbumName(s, clean, need(), id)) });
  return { id, name: clean, itemIds: [] };
}

/** The server takes at most 500 items per request. */
export async function addToAlbum(id: string, itemIds: string[]) {
  for (let i = 0; i < itemIds.length; i += 500) await api("PUT", `/api/albums/${id}/items`, { item_ids: itemIds.slice(i, i + 500) });
}

export async function renameAlbum(id: string, name: string): Promise<string> {
  const s = await getSodium();
  const clean = name.trim().slice(0, 100);
  await api("PATCH", `/api/albums/${id}`, { name_enc: b64(s, encryptAlbumName(s, clean, need(), id)) });
  return clean;
}

/** Removes the album only; its photos stay in the library. */
export const deleteAlbum = (id: string) => api("DELETE", `/api/albums/${id}`);

export async function removeFromAlbum(id: string, itemIds: string[]) {
  for (const item of itemIds) await api("DELETE", `/api/albums/${id}/items/${item}`);
}
