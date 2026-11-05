import type { Sodium } from "./sodium";
import { CTX, subkey } from "./kdf";
import { open, seal } from "./wrap";
import type { KeyPair } from "./item";

// The search index (docs/SEARCH.md). One entry per item: what the phone found in it (an image vector, the faces with
// their positions and vectors). Entries are sealed to the account's public key, like the background backup's item
// keys, so the phone can index in the background without the master key; only the account's private key opens them.
// The item id is sealed in, so an entry can't be moved to another item.
//   version(2) || crypto_box_seal(item id as 16 bytes || padded JSON)

const VERSION = 2;
const PAD = 512;

export interface IndexEntry {
  v: 1;
  /** which models made it: entries from older models are made again */
  m: string;
  /** image vector, float16 little-endian, base64url */
  clip?: string;
  /** faces: box (x, y, w, h in 0..1 of the image), detector score, face vector (float16, base64url) */
  faces?: { box: number[]; score: number; emb: string }[];
}

export function sealIndexEntry(s: Sodium, entry: IndexEntry, pubkey: Uint8Array, itemId: string): Uint8Array {
  const json = s.pad(s.from_string(JSON.stringify(entry)), PAD);
  const id = s.from_hex(itemId);
  if (id.length !== 16) throw new Error("bad item id");
  const pt = new Uint8Array(16 + json.length);
  pt.set(id);
  pt.set(json, 16);
  const c = s.crypto_box_seal(pt, pubkey);
  const out = new Uint8Array(1 + c.length);
  out[0] = VERSION;
  out.set(c, 1);
  return out;
}

export function openIndexEntry(s: Sodium, blob: Uint8Array, pair: KeyPair, itemId: string): IndexEntry {
  if (blob.length < 1 + 48 + 16 || blob[0] !== VERSION) throw new Error("bad blob");
  const pt = s.crypto_box_seal_open(blob.subarray(1), pair.pk, pair.sk);
  const id = s.from_hex(itemId);
  if (pt.length < 16 || id.length !== 16 || !s.memcmp(pt.subarray(0, 16), id)) throw new Error("index entry belongs to another item");
  const e = JSON.parse(s.to_string(s.unpad(pt.subarray(16), PAD))) as IndexEntry;
  if (e.v !== 1) throw new Error("unknown index version");
  return e;
}

/** The people list (names, which faces belong to whom): one document per account, under a subkey of the master key. */
export const encryptPeople = (s: Sodium, data: unknown, masterKey: Uint8Array, userId: string) =>
  seal(s, s.pad(s.from_string(JSON.stringify(data)), 1024), subkey(s, masterKey, CTX.people, 0), "blob/people", userId);

export function decryptPeople<T>(s: Sodium, blob: Uint8Array, masterKey: Uint8Array, userId: string): T {
  return JSON.parse(s.to_string(s.unpad(open(s, blob, subkey(s, masterKey, CTX.people, 0), "blob/people", userId), 1024))) as T;
}
