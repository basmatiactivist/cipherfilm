// @ts-nocheck (uses Node APIs; only ever runs under vitest, never in the browser build)
// Writes known-good ciphertext produced by the app's own code, for the independent Go decrypt tool's tests
// (tools/decrypt). Skipped unless WRITE_VECTORS names an output file:
//   WRITE_VECTORS=/out/vectors.json npx vitest run src/crypto/vectors.gen.test.ts
import { writeFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { getSodium, b64, Sodium } from "./sodium";
import { newKdfParams } from "./kdf";
import { createAccount } from "./account";
import { encryptAlbumName, encryptMeta, encryptPreview, newItemKey, sealItemKey, wrapItemKey } from "./item";
import { encryptSegment } from "./file";

let s: Sodium;
beforeAll(async () => { s = await getSodium(); });

test.skipIf(!process.env.WRITE_VECTORS)("write vectors", async () => {
  const email = "Vector.User@Example.com";
  const password = "correct horse battery staple ü";
  const kdf = newKdfParams(s, 2, 32 * 1024 * 1024);
  const acct = await createAccount(s, email, password, kdf);
  const itemId = "0123456789abcdef0123456789abcdef";
  const itemKey = newItemKey(s);
  const sizes = [0, 1, 70000, 300000]; // empty, tiny, two chunks, five chunks
  const files = sizes.map((size, n) => {
    const id = n.toString(16).padStart(2, "0") + itemId.slice(2);
    const key = newItemKey(s);
    const plain = s.randombytes_buf(size);
    const meta = { name: `file-${n}.bin`, mime: "application/octet-stream", size, lastModified: 1700000000000, capture_ts: 1700000000000 };
    return {
      id, size, count: 1,
      wrapped_item_key: b64(s, wrapItemKey(s, key, acct.masterKey, id)),
      meta_enc: b64(s, encryptMeta(s, meta, key, id)),
      segment0: b64(s, encryptSegment(s, key, id, 0, 1, size, plain)),
      sha256: Buffer.from(s.crypto_hash_sha256(plain)).toString("hex"),
      name: meta.name,
    };
  });
  // a file from the phone's background backup: its key is sealed to the account's public key
  const sealedId = "5e" + itemId.slice(2);
  const sealedKey = newItemKey(s);
  const sealedMeta = { name: "from-backup.jpg", mime: "image/jpeg", size: 1, lastModified: 1700000000000, capture_ts: 1700000000000 };
  const sealed = {
    id: sealedId, size: 1, name: sealedMeta.name,
    wrapped_item_key: b64(s, sealItemKey(s, sealedKey, s.from_base64(acct.bundle.pubkey, s.base64_variants.URLSAFE_NO_PADDING), sealedId)),
    meta_enc: b64(s, encryptMeta(s, sealedMeta, sealedKey, sealedId)),
  };
  const albumId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(process.env.WRITE_VECTORS!, JSON.stringify({
    email, password, kdf, recovery_words: acct.recoveryWords.join(" "),
    wrapped_master_pw: acct.bundle.wrapped_master_pw, wrapped_master_recovery: acct.bundle.wrapped_master_recovery,
    wrapped_privkey: acct.bundle.wrapped_privkey, pubkey: acct.bundle.pubkey, sealed,
    album: { id: albumId, name: "Sommer 🌅 2024", name_enc: b64(s, encryptAlbumName(s, "Sommer 🌅 2024", acct.masterKey, albumId)) },
    files,
  }));
  expect(files.length).toBe(4);
}, 60_000);
