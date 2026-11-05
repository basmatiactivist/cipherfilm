import sodium from "libsodium-wrappers-sumo";
import type { Sodium } from "./sodium";

/** libsodium's sumo build, with Argon2 (crypto_pwhash). Only the kdf worker loads it: it is a third bigger. */
export async function getSumo(): Promise<Sodium> {
  await sodium.ready;
  return sodium as Sodium;
}
