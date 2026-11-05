import { describe, expect, test } from "vitest";
import { getSodium } from "./sodium";

// The main thread, the Service Worker and the other workers load libsodium's standard build; only the kdf worker
// loads sumo. Both share one type, so the compiler can't tell when code calls something only sumo has.
const SUMO_ONLY = new Set(["crypto_pwhash", "crypto_pwhash_ALG_ARGON2ID13"]); // deriveFromPassword in kdf.ts, run in the kdf worker

const sources = (import.meta as unknown as { glob(p: string[], o: object): Record<string, string> })
  .glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts"], { query: "?raw", import: "default", eager: true });

describe("libsodium standard build", () => {
  test("has every function the app calls outside the kdf worker", async () => {
    const s = (await getSodium()) as unknown as Record<string, unknown>;
    const used = new Set<string>();
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(/\bs\.((?:crypto|randombytes)_\w+|memzero|memcmp|pad|unpad|to_\w+|from_\w+|base64_variants)\b/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(20);
    const missing = [...used].filter((n) => !SUMO_ONLY.has(n) && s[n] === undefined);
    expect(missing).toEqual([]);
  });
});
