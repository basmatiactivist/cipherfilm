import sodium from "libsodium-wrappers";

// libsodium's standard build: everything the app needs but Argon2, which only the kdf worker runs (sodium-sumo.ts).
// Both builds share one API type; sodium.test.ts checks that every function called outside the worker exists here.
export type Sodium = typeof sodium;

/** Resolves once libsodium's WASM is initialised. */
export async function getSodium(): Promise<Sodium> {
  await sodium.ready;
  return sodium;
}

export const b64 = (s: Sodium, u: Uint8Array): string => s.to_base64(u, s.base64_variants.URLSAFE_NO_PADDING);
export const unb64 = (s: Sodium, t: string): Uint8Array => s.from_base64(t, s.base64_variants.URLSAFE_NO_PADDING);
