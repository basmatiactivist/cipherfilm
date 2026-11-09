// @ts-nocheck (uses Node APIs; only ever runs under vitest, never in the browser build)
// The web client's crypto (also the Android app's, mobile/ imports it) must still read the committed vectors
// (tools/decrypt/testdata/vectors.json, written once by vectors.gen.test.ts and decrypted by the independent Go tool
// and the Mac app's tests): a change that breaks the format is caught here, not in someone's restore.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { unb64, Sodium } from "./sodium";
import { getSumo } from "./sodium-sumo"; // with Argon2, as the kdf worker has it
import { deriveFromPassword } from "./kdf";
import { recoveryProof, unlockMasterKey, unlockWithRecovery } from "./account";
import { accountKeyPair, decryptAlbumName, decryptMeta, unwrapAnyItemKey } from "./item";
import { decryptSegment } from "./file";

const v = JSON.parse(readFileSync(new URL("../../../tools/decrypt/testdata/vectors.json", import.meta.url), "utf8"));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
let s: Sodium;
let master: Uint8Array;
beforeAll(async () => {
  s = await getSumo();
  master = unlockMasterKey(s, v.email, deriveFromPassword(s, v.password, v.kdf).kek, v.wrapped_master_pw);
});

describe("the committed crypto vectors", () => {
  test("the password and the recovery words open the same master key", async () => {
    const { recWrap } = await recoveryProof(s, v.recovery_words);
    expect(hex(unlockWithRecovery(s, v.email, recWrap, v.wrapped_master_recovery))).toBe(hex(master));
    expect(() => unlockMasterKey(s, v.email, deriveFromPassword(s, v.password + "x", v.kdf).kek, v.wrapped_master_pw)).toThrow();
    expect(() => unlockMasterKey(s, "other@example.com", deriveFromPassword(s, v.password, v.kdf).kek, v.wrapped_master_pw)).toThrow();
  });

  test("every file: key, metadata and contents decrypt to what was written, and only for its own id", () => {
    const never = () => { throw new Error("no key pair needed"); };
    for (const f of v.files) {
      const key = unwrapAnyItemKey(s, unb64(s, f.wrapped_item_key), master, never, f.id);
      const meta = decryptMeta<{ name: string; size: number }>(s, unb64(s, f.meta_enc), key, f.id);
      expect([meta.name, meta.size]).toEqual([f.name, f.size]);
      const plain = decryptSegment(s, key, f.id, 0, f.count, f.size, unb64(s, f.segment0));
      expect(hex(s.crypto_hash_sha256(plain))).toBe(f.sha256);
      const other = v.files.find((x) => x.id !== f.id).id;
      expect(() => decryptSegment(s, key, other, 0, f.count, f.size, unb64(s, f.segment0))).toThrow();
      const bad = unb64(s, f.segment0); bad[bad.length - 3] ^= 1;
      expect(() => decryptSegment(s, key, f.id, 0, f.count, f.size, bad)).toThrow();
    }
  });

  test("the background backup's sealed key opens with the account key pair, the album name with the master key", () => {
    const pair = accountKeyPair(s, unb64(s, v.wrapped_privkey), master, v.email.trim().toLowerCase());
    expect(s.to_base64(pair.pk, s.base64_variants.URLSAFE_NO_PADDING)).toBe(v.pubkey);
    const key = unwrapAnyItemKey(s, unb64(s, v.sealed.wrapped_item_key), master, () => pair, v.sealed.id);
    const meta = decryptMeta<{ name: string; size: number }>(s, unb64(s, v.sealed.meta_enc), key, v.sealed.id);
    expect([meta.name, meta.size]).toEqual([v.sealed.name, v.sealed.size]);
    expect(() => unwrapAnyItemKey(s, unb64(s, v.sealed.wrapped_item_key), master, () => pair, v.files[0].id)).toThrow();
    expect(decryptAlbumName(s, unb64(s, v.album.name_enc), master, v.album.id)).toBe(v.album.name);
  });
});
