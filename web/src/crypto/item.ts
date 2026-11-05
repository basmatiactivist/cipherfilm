import type { Sodium } from "./sodium";
import { CTX, subkey } from "./kdf";
import { LABEL, open, seal } from "./wrap";

const PAD = 256;

export function newItemKey(s: Sodium): Uint8Array {
  return s.randombytes_buf(32);
}

export const wrapItemKey = (s: Sodium, itemKey: Uint8Array, masterKey: Uint8Array, itemId: string) =>
  seal(s, itemKey, masterKey, LABEL.itemKey, itemId);

export const unwrapItemKey = (s: Sodium, wrapped: Uint8Array, masterKey: Uint8Array, itemId: string) =>
  open(s, wrapped, masterKey, LABEL.itemKey, itemId);

// Item keys made where the master key is not available (the phone's background backup) are sealed to the account's
// public key instead: that uploader can add photos but never read any. The item id is sealed in with the key, so a
// key can't be moved to another item. version(2) || crypto_box_seal(itemKey || item id as 16 bytes)
const SEALED = 2;
export const SEALED_ITEM_KEY_LEN = 1 + 48 + 48;

export function sealItemKey(s: Sodium, itemKey: Uint8Array, pubkey: Uint8Array, itemId: string): Uint8Array {
  const pt = new Uint8Array(48);
  pt.set(itemKey);
  pt.set(s.from_hex(itemId), 32);
  const c = s.crypto_box_seal(pt, pubkey);
  s.memzero(pt);
  const out = new Uint8Array(1 + c.length);
  out[0] = SEALED;
  out.set(c, 1);
  return out;
}

export function openSealedItemKey(s: Sodium, blob: Uint8Array, pair: KeyPair, itemId: string): Uint8Array {
  if (blob.length !== SEALED_ITEM_KEY_LEN || blob[0] !== SEALED) throw new Error("bad blob");
  const pt = s.crypto_box_seal_open(blob.subarray(1), pair.pk, pair.sk);
  const id = s.from_hex(itemId);
  if (pt.length !== 48 || id.length !== 16 || !s.memcmp(pt.subarray(32), id)) throw new Error("item key belongs to another item");
  const key = pt.slice(0, 32);
  s.memzero(pt);
  return key;
}

export interface KeyPair { pk: Uint8Array; sk: Uint8Array }

/** The account's key pair, opened with the master key; the public half is computed, not taken from the server. */
export function accountKeyPair(s: Sodium, wrappedPrivkey: Uint8Array, masterKey: Uint8Array, normalizedEmail: string): KeyPair {
  const sk = open(s, wrappedPrivkey, masterKey, LABEL.privkey, normalizedEmail);
  return { sk, pk: s.crypto_scalarmult_base(sk) };
}

/** Either kind of item key. pair() is asked only when a sealed one turns up. */
export function unwrapAnyItemKey(s: Sodium, wrapped: Uint8Array, masterKey: Uint8Array, pair: () => KeyPair, itemId: string): Uint8Array {
  return wrapped[0] === SEALED ? openSealedItemKey(s, wrapped, pair(), itemId) : unwrapItemKey(s, wrapped, masterKey, itemId);
}

/** Metadata JSON, padded to a multiple of 256 bytes, sealed under a key derived from the item key. */
export function encryptMeta(s: Sodium, meta: unknown, itemKey: Uint8Array, itemId: string): Uint8Array {
  const json = s.from_string(JSON.stringify(meta));
  const padded = s.pad(json, PAD);
  const out = seal(s, padded, subkey(s, itemKey, CTX.itemMeta, 0), LABEL.meta, itemId);
  return out;
}

export function decryptMeta<T = unknown>(s: Sodium, blob: Uint8Array, itemKey: Uint8Array, itemId: string): T {
  const padded = open(s, blob, subkey(s, itemKey, CTX.itemMeta, 0), LABEL.meta, itemId);
  return JSON.parse(s.to_string(s.unpad(padded, PAD))) as T;
}

/** Thumbnails and previews: single-shot AEAD under per-purpose subkeys of the item key. */
export const encryptThumb = (s: Sodium, data: Uint8Array, itemKey: Uint8Array, itemId: string) =>
  seal(s, data, subkey(s, itemKey, CTX.itemThumb, 0), "thumb", itemId);
export const decryptThumb = (s: Sodium, blob: Uint8Array, itemKey: Uint8Array, itemId: string) =>
  open(s, blob, subkey(s, itemKey, CTX.itemThumb, 0), "thumb", itemId);
export const encryptPreview = (s: Sodium, data: Uint8Array, itemKey: Uint8Array, itemId: string) =>
  seal(s, data, subkey(s, itemKey, CTX.itemPrev, 0), "preview", itemId);
export const decryptPreview = (s: Sodium, blob: Uint8Array, itemKey: Uint8Array, itemId: string) =>
  open(s, blob, subkey(s, itemKey, CTX.itemPrev, 0), "preview", itemId);

/** Album names are padded, bound to the album id, and sealed under a subkey of the master key. */
export const encryptAlbumName = (s: Sodium, name: string, masterKey: Uint8Array, albumId: string) =>
  seal(s, s.pad(s.from_string(name), 64), subkey(s, masterKey, CTX.albumName, 0), "album/name", albumId);
export const decryptAlbumName = (s: Sodium, blob: Uint8Array, masterKey: Uint8Array, albumId: string): string =>
  s.to_string(s.unpad(open(s, blob, subkey(s, masterKey, CTX.albumName, 0), "album/name", albumId), 64));
