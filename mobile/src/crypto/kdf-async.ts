import { getSodium } from "@crypto/sodium";
import { deriveFromPassword, KdfParams } from "@crypto/kdf";

/** The web version moves Argon2 to a worker. Here it runs natively; the timeout lets the screen show "Unlocking" first.
 *  Same signature as web/src/crypto/kdf-async.ts, which Metro swaps for this file (metro.config.js). */
export function deriveAsync(password: string, p: KdfParams): Promise<{ authKey: Uint8Array; kek: Uint8Array }> {
  return new Promise((resolve, reject) => setTimeout(() => {
    getSodium().then((s) => resolve(deriveFromPassword(s, password, p))).catch(reject);
  }, 50));
}

// tsc fails here if the web version's signature changes and this one is left behind (it broke sign-in once)
import type { deriveAsync as WebDeriveAsync } from "@crypto/kdf-async";
const sameSignature: typeof WebDeriveAsync = deriveAsync;
void sameSignature;
