import type { Sodium } from "@crypto/sodium";
import { deriveFromPassword, KdfParams } from "@crypto/kdf";

/** The web version moves Argon2 to a worker. Here it runs natively; the timeout lets the screen show "Unlocking" first. */
export function deriveAsync(s: Sodium, password: string, p: KdfParams): Promise<{ authKey: Uint8Array; kek: Uint8Array }> {
  return new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(deriveFromPassword(s, password, p)); } catch (e) { reject(e); }
  }, 50));
}
