import type { Sodium } from "./sodium";
import { b64, unb64 } from "./sodium";

/** Fixed 8-byte contexts for crypto_kdf. Every label must be unique (tested). */
export const CTX = {
  auth: "AUTHKEY1",
  kek: "KEKWRAP1",
  recAuth: "RECAUTH1",
  recWrap: "RECWRAP1",
  albumName: "ALBUMNAM",
  itemMeta: "ITEMMETA",
  itemThumb: "ITEMTHMB",
  itemPrev: "ITEMPREV",
  itemSeg: "ITEMSEGM",
  people: "PEOPLEST",
} as const;

export interface KdfParams {
  alg: "argon2id13";
  v: 1;
  ops: number;
  /** bytes */
  mem: number;
  /** base64url, 16 bytes */
  salt: string;
}

/** Defaults: ~1-2 s on a mid-range phone, to be tuned on devices. Server enforces a floor. */
export const DEFAULT_KDF = { ops: 3, mem: 64 * 1024 * 1024 } as const;

/** crypto_pwhash_SALTBYTES; the standard libsodium build on the main thread has no crypto_pwhash constants. */
const SALT_BYTES = 16;

export function newKdfParams(s: Sodium, ops: number = DEFAULT_KDF.ops, mem: number = DEFAULT_KDF.mem): KdfParams {
  return { alg: "argon2id13", v: 1, ops, mem, salt: b64(s, s.randombytes_buf(SALT_BYTES)) };
}

export function subkey(s: Sodium, key: Uint8Array, ctx: string, id: number): Uint8Array {
  return s.crypto_kdf_derive_from_key(32, id, ctx, key);
}

/** password -> Argon2id(32 B) -> authKey + KEK (two independent subkeys). Needs the sumo build (getSumo). */
export function deriveFromPassword(s: Sodium, password: string, p: KdfParams): { authKey: Uint8Array; kek: Uint8Array } {
  if (p.alg !== "argon2id13" || p.v !== 1) throw new Error("unsupported kdf params");
  const root = s.crypto_pwhash(32, password.normalize("NFKC"), unb64(s, p.salt), p.ops, p.mem, s.crypto_pwhash_ALG_ARGON2ID13);
  const authKey = subkey(s, root, CTX.auth, 1);
  const kek = subkey(s, root, CTX.kek, 2);
  s.memzero(root);
  return { authKey, kek };
}
