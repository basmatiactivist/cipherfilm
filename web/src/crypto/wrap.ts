import type { Sodium } from "./sodium";

const VERSION = 1;
const NONCE = 24;

export const WRAPPED_KEY_LEN = 1 + NONCE + 32 + 16; // 73

function adFor(s: Sodium, label: string, owner: string): Uint8Array {
  return s.from_string(label + "\0" + owner);
}

/** version(1) || nonce(24) || XChaCha20-Poly1305(plaintext, ad = label \0 owner) */
export function seal(s: Sodium, plaintext: Uint8Array, key: Uint8Array, label: string, owner: string): Uint8Array {
  const nonce = s.randombytes_buf(NONCE);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, adFor(s, label, owner), null, nonce, key);
  const out = new Uint8Array(1 + NONCE + ct.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE);
  return out;
}

export function open(s: Sodium, blob: Uint8Array, key: Uint8Array, label: string, owner: string): Uint8Array {
  if (blob.length < 1 + NONCE + 16 || blob[0] !== VERSION) throw new Error("bad blob");
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    blob.subarray(1 + NONCE),
    adFor(s, label, owner),
    blob.subarray(1, 1 + NONCE),
    key,
  );
}

export const LABEL = {
  masterPw: "wrap/master/pw",
  masterRecovery: "wrap/master/recovery",
  privkey: "wrap/privkey",
  itemKey: "wrap/item",
  meta: "meta",
} as const;
