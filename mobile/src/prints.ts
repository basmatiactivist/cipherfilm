import { getSodium } from "@crypto/sodium";

/** A photo by name and size: how the backup, search and "Free up space" recognise a phone's photo in the library. */
export async function fingerprint(name: string, size: number) {
  const s = await getSodium();
  return s.to_hex(s.crypto_generichash(16, `${name}\0${size}`, null));
}
