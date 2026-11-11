// Albums as the web app keeps them: names encrypted under the master key, bound to the album id.
import { getSodium, b64, unb64, type Sodium } from "@crypto/sodium";
import { decryptAlbumName, encryptAlbumName } from "@crypto/item";
import { api } from "./api";
import { onWipe, session } from "./session";
import { ListSync, type Page } from "./sync";
import { t } from "./i18n";

export interface Album { id: string; name: string; itemIds: string[]; created_at?: number; broken?: boolean }

const need = () => {
  const k = session().masterKey;
  if (!k) throw new Error(t("Unlock your library first."));
  return k;
};

interface RawAlbum { id: string; name_enc: string; created_at?: number; item_ids: string[] }

function decryptAlbums(s: Sodium, master: Uint8Array, raw: RawAlbum[]): Album[] {
  return raw.map((a) => {
    try {
      return { id: a.id, name: decryptAlbumName(s, unb64(s, a.name_enc), master, a.id), itemIds: a.item_ids, created_at: a.created_at };
    } catch {
      return { id: a.id, name: t("Unreadable album"), itemIds: a.item_ids, created_at: a.created_at, broken: true };
    }
  });
}

// The album list, kept current with ?since like the library (sync.ts): after the whole list, a live update asks the
// server only for the albums that changed (each whole) and those deleted, and decrypts only their names. Dropped at
// every lock and sign-out, and when the master key it was made with is no longer the one in use.
let sodium: Sodium | undefined;
let listKey: Uint8Array | null = null;
const albumOrder = (a: Album, b: Album) => (a.created_at ?? 0) - (b.created_at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const albums = new ListSync<Album>({
  path: "/api/albums",
  // the server's answers name the list "albums"; ListSync reads "items"
  get: async (p) => { const r = await api<Page & { albums?: RawAlbum[] }>("GET", p); return { ...r, items: r.albums ?? [] }; },
  decrypt: (raw) => decryptAlbums(sodium!, need(), raw as RawAlbum[]),
  order: albumOrder,
});

/** Drops the album list and its cursor: the next load is a whole one. */
export function forgetAlbumList() { albums.forget(); listKey = null; }
onWipe(() => forgetAlbumList());

export async function loadAlbums(): Promise<Album[]> {
  sodium = await getSodium();
  const master = need();
  if (listKey !== master) { albums.forget(); listKey = master; }
  return [...(await albums.load()).items];
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
