import type { Sodium } from "./sodium";
import { b64, unb64 } from "./sodium";
import { CTX, KdfParams, newKdfParams, subkey } from "./kdf";
import { deriveAsync } from "./kdf-async";
import { LABEL, open, seal } from "./wrap";
import { keyToWords, wordsToKey } from "./recovery";

/** Wire format shared with the server. The server never sees anything that can decrypt. */
export interface KeyBundle {
  kdf: KdfParams;
  auth: string;
  wrapped_master_pw: string;
  wrapped_master_recovery: string;
  wrapped_privkey: string;
  pubkey: string;
  recovery_verifier: string;
}

export interface NewAccount {
  bundle: KeyBundle;
  masterKey: Uint8Array;
  recoveryWords: string[];
}

/** Owner binding for wrapped keys: the normalised e-mail (immutable in v1). */
export const normEmail = (e: string): string => e.trim().toLowerCase();

function recoveryParts(s: Sodium, recoveryKey: Uint8Array) {
  return { recAuth: subkey(s, recoveryKey, CTX.recAuth, 1), recWrap: subkey(s, recoveryKey, CTX.recWrap, 2) };
}

/** Create all key material for a brand-new account (setup / invite acceptance). */
export async function createAccount(s: Sodium, email: string, password: string, kdf: KdfParams = newKdfParams(s)): Promise<NewAccount> {
  const owner = normEmail(email);
  const { authKey, kek } = await deriveAsync(password, kdf);
  const masterKey = s.randombytes_buf(32);
  const recoveryKey = s.randombytes_buf(32);
  const { recAuth, recWrap } = recoveryParts(s, recoveryKey);
  const kp = s.crypto_box_keypair();
  const bundle: KeyBundle = {
    kdf,
    auth: b64(s, authKey),
    wrapped_master_pw: b64(s, seal(s, masterKey, kek, LABEL.masterPw, owner)),
    wrapped_master_recovery: b64(s, seal(s, masterKey, recWrap, LABEL.masterRecovery, owner)),
    wrapped_privkey: b64(s, seal(s, kp.privateKey, masterKey, LABEL.privkey, owner)),
    pubkey: b64(s, kp.publicKey),
    recovery_verifier: b64(s, recAuth),
  };
  const recoveryWords = await keyToWords(recoveryKey);
  for (const k of [authKey, kek, recoveryKey, recWrap, kp.privateKey]) s.memzero(k);
  return { bundle, masterKey, recoveryWords };
}

/** Login: derive keys from the password; returns the login proof and (after server reply) the master key. */
export async function loginProof(s: Sodium, password: string, kdf: KdfParams) {
  const { authKey, kek } = await deriveAsync(password, kdf);
  return { auth: b64(s, authKey), kek };
}

export function unlockMasterKey(s: Sodium, email: string, kek: Uint8Array, wrappedMasterPw: string): Uint8Array {
  return open(s, unb64(s, wrappedMasterPw), kek, LABEL.masterPw, normEmail(email));
}

/** Re-wrap the master key under a new password. Data is not re-encrypted. */
export async function rewrapForPassword(s: Sodium, email: string, masterKey: Uint8Array, newPassword: string, kdf: KdfParams = newKdfParams(s)) {
  const { authKey, kek } = await deriveAsync(newPassword, kdf);
  const out = {
    new_kdf: kdf,
    new_auth: b64(s, authKey),
    new_wrapped_master_pw: b64(s, seal(s, masterKey, kek, LABEL.masterPw, normEmail(email))),
  };
  s.memzero(authKey);
  s.memzero(kek);
  return out;
}

/** Step 1 of recovery: the proof sent to the server. */
export async function recoveryProof(s: Sodium, words: string) {
  const recoveryKey = await wordsToKey(words);
  const { recAuth, recWrap } = recoveryParts(s, recoveryKey);
  const proof = b64(s, recAuth);
  s.memzero(recAuth);
  s.memzero(recoveryKey);
  return { recovery_auth: proof, recWrap }; // the caller zeroes recWrap once it opened the master key
}

export function unlockWithRecovery(s: Sodium, email: string, recWrap: Uint8Array, wrappedMasterRecovery: string): Uint8Array {
  return open(s, unb64(s, wrappedMasterRecovery), recWrap, LABEL.masterRecovery, normEmail(email));
}

/** Recovery step 2: new password and a rotated recovery key (shown to the user once again). */
export async function finishRecovery(s: Sodium, email: string, masterKey: Uint8Array, newPassword: string, kdf: KdfParams = newKdfParams(s)) {
  const owner = normEmail(email);
  const newRecoveryKey = s.randombytes_buf(32);
  const { recAuth, recWrap } = recoveryParts(s, newRecoveryKey);
  try {
    const body = {
      ...(await rewrapForPassword(s, email, masterKey, newPassword, kdf)),
      new_wrapped_master_recovery: b64(s, seal(s, masterKey, recWrap, LABEL.masterRecovery, owner)),
      new_recovery_verifier: b64(s, recAuth),
    };
    return { body, recoveryWords: await keyToWords(newRecoveryKey) };
  } finally {
    for (const k of [newRecoveryKey, recAuth, recWrap]) s.memzero(k);
  }
}

/** A fresh recovery key for an existing account: new wrap of the master key plus a new verifier. The old key stops working. */
export async function newRecoveryKit(s: Sodium, email: string, masterKey: Uint8Array) {
  const recoveryKey = s.randombytes_buf(32);
  const { recAuth, recWrap } = recoveryParts(s, recoveryKey);
  const kit = {
    wrapped_master_recovery: b64(s, seal(s, masterKey, recWrap, LABEL.masterRecovery, normEmail(email))),
    recovery_verifier: b64(s, recAuth),
    words: await keyToWords(recoveryKey),
  };
  for (const k of [recoveryKey, recAuth, recWrap]) s.memzero(k);
  return kit;
}
