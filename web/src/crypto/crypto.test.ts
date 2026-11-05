import { beforeAll, describe, expect, test } from "vitest";
import { getSodium, Sodium, unb64 } from "./sodium";
import { CTX, newKdfParams } from "./kdf";
import { newRecoveryKit, createAccount, finishRecovery, loginProof, recoveryProof, rewrapForPassword, unlockMasterKey, unlockWithRecovery } from "./account";
import { keyToWords, wordsToKey } from "./recovery";
import { decryptAlbumName, encryptAlbumName, decryptMeta, encryptMeta, newItemKey, unwrapItemKey, wrapItemKey } from "./item";
import { open, seal } from "./wrap";
import { cipherLen, decryptSegment, encryptSegment, segmentCount, SEG_PLAIN, CHUNK } from "./file";

let s: Sodium;
// Cheap Argon2 settings for unit tests only (the server enforces a floor in production).
const fast = () => newKdfParams(s, 1, 8 * 1024 * 1024);
const EMAIL = "Alice@Example.com";

beforeAll(async () => {
  s = await getSodium();
});

describe("kdf contexts", () => {
  test("labels are unique and 8 bytes", async () => {
    const v = Object.values(CTX);
    expect(new Set(v).size).toBe(v.length);
    v.forEach((c) => expect(c.length).toBe(8));
  });
});

describe("wrap", () => {
  test("round trip, wrong key / label / owner / tamper all fail", async () => {
    const k = s.randombytes_buf(32);
    const blob = seal(s, s.from_string("secret"), k, "L", "o");
    expect(s.to_string(open(s, blob, k, "L", "o"))).toBe("secret");
    expect(() => open(s, blob, s.randombytes_buf(32), "L", "o")).toThrow();
    expect(() => open(s, blob, k, "L2", "o")).toThrow();
    expect(() => open(s, blob, k, "L", "o2")).toThrow();
    const bad = blob.slice();
    bad[40] ^= 1;
    expect(() => open(s, bad, k, "L", "o")).toThrow();
  });
});

describe("recovery words", () => {
  test("round trip, typo and checksum detection", async () => {
    const k = s.randombytes_buf(32);
    const words = await keyToWords(k);
    expect(words).toHaveLength(24);
    expect(await wordsToKey(words.join(" ").toUpperCase())).toEqual(k);
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    if (swapped[0] !== words[0]) await expect(wordsToKey(swapped.join(" "))).rejects.toThrow();
    await expect(wordsToKey("abandon ".repeat(24))).rejects.toThrow();
    await expect(wordsToKey("nonsenseword " + words.slice(1).join(" "))).rejects.toThrow();
  });
});

describe("account lifecycle", () => {
  test("login unlocks the master key; wrong password cannot", async () => {
    const acc = await createAccount(s, EMAIL, "correct horse battery", fast());
    const { auth, kek } = await loginProof(s, "correct horse battery", acc.bundle.kdf);
    expect(auth).toBe(acc.bundle.auth);
    expect(unlockMasterKey(s, EMAIL, kek, acc.bundle.wrapped_master_pw)).toEqual(acc.masterKey);
    const wrong = await loginProof(s, "wrong password!!", acc.bundle.kdf);
    expect(wrong.auth).not.toBe(acc.bundle.auth);
    expect(() => unlockMasterKey(s, EMAIL, wrong.kek, acc.bundle.wrapped_master_pw)).toThrow();
  });

  test("auth key and KEK are independent", async () => {
    const acc = await createAccount(s, EMAIL, "pw-pw-pw-pw-pw", fast());
    const { kek } = await loginProof(s, "pw-pw-pw-pw-pw", acc.bundle.kdf);
    expect(unb64(s, acc.bundle.auth)).not.toEqual(kek);
  });

  test("wrapped keys are bound to the owner", async () => {
    const acc = await createAccount(s, EMAIL, "pw-pw-pw-pw-pw", fast());
    const { kek } = await loginProof(s, "pw-pw-pw-pw-pw", acc.bundle.kdf);
    expect(() => unlockMasterKey(s, "bob@example.com", kek, acc.bundle.wrapped_master_pw)).toThrow();
  });

  test("password change keeps data readable", async () => {
    const acc = await createAccount(s, EMAIL, "old-password-1", fast());
    const itemKey = newItemKey(s);
    const wrapped = wrapItemKey(s, itemKey, acc.masterKey, "item1");
    const meta = encryptMeta(s, { name: "IMG_1.HEIC", gps: [1, 2] }, itemKey, "item1");

    const ch = await rewrapForPassword(s, EMAIL, acc.masterKey, "new-password-2", fast());
    const { kek } = await loginProof(s, "new-password-2", ch.new_kdf);
    const master2 = unlockMasterKey(s, EMAIL, kek, ch.new_wrapped_master_pw);
    const k2 = unwrapItemKey(s, wrapped, master2, "item1");
    expect(decryptMeta<{ name: string }>(s, meta, k2, "item1").name).toBe("IMG_1.HEIC");
  });

  test("recovery keeps data readable and rotates the recovery key", async () => {
    const acc = await createAccount(s, EMAIL, "lost-password-1", fast());
    const itemKey = newItemKey(s);
    const wrapped = wrapItemKey(s, itemKey, acc.masterKey, "item1");

    const proof = await recoveryProof(s, acc.recoveryWords.join(" "));
    expect(proof.recovery_auth).toBe(acc.bundle.recovery_verifier);
    const master = unlockWithRecovery(s, EMAIL, proof.recWrap, acc.bundle.wrapped_master_recovery);
    expect(master).toEqual(acc.masterKey);

    const fin = await finishRecovery(s, EMAIL, master, "brand-new-pass-3", fast());
    expect(fin.recoveryWords).not.toEqual(acc.recoveryWords);
    const { kek } = await loginProof(s, "brand-new-pass-3", fin.body.new_kdf);
    const m2 = unlockMasterKey(s, EMAIL, kek, fin.body.new_wrapped_master_pw);
    expect(unwrapItemKey(s, wrapped, m2, "item1")).toEqual(itemKey);

    // old recovery key no longer matches the new verifier
    expect(proof.recovery_auth).not.toBe(fin.body.new_recovery_verifier);
    const p2 = await recoveryProof(s, fin.recoveryWords.join(" "));
    expect(p2.recovery_auth).toBe(fin.body.new_recovery_verifier);
  });
});

describe("items", () => {
  test("meta round trip; wrong item id, wrong key and tamper fail; padding hides length", async () => {
    const k = newItemKey(s);
    const a = encryptMeta(s, { n: "a" }, k, "id1");
    const b = encryptMeta(s, { n: "a longer value but still small" }, k, "id1");
    expect(a.length).toBe(b.length);
    expect(decryptMeta(s, a, k, "id1")).toEqual({ n: "a" });
    expect(() => decryptMeta(s, a, k, "id2")).toThrow();
    expect(() => decryptMeta(s, a, newItemKey(s), "id1")).toThrow();
    const t = a.slice();
    t[t.length - 1] ^= 1;
    expect(() => decryptMeta(s, t, k, "id1")).toThrow();
  });

  test("item key cannot be unwrapped for another item id", async () => {
    const m = s.randombytes_buf(32);
    const w = wrapItemKey(s, newItemKey(s), m, "a");
    expect(() => unwrapItemKey(s, w, m, "b")).toThrow();
  });
});

// randombytes_buf is slow for MiB-sized buffers; encryption itself is fast. Test data only needs to be non-trivial.
function fill(n: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
  return b;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("file segments", () => {
  const total = 3 * 1024 * 1024; // keep unit tests fast: single segment, several chunks
  const plain = () => fill(total);

  test("round trip across chunk boundaries and edge sizes", () => {
    const k = newItemKey(s);
    for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, total]) {
      const p = fill(n);
      const ct = encryptSegment(s, k, "item", 0, 1, n, p);
      expect(ct.length).toBe(cipherLen(n));
      expect(same(decryptSegment(s, k, "item", 0, 1, n, ct), p)).toBe(true);
    }
  });

  test("ciphertext does not contain the plaintext", () => {
    const k = newItemKey(s);
    const marker = s.from_string("SECRET-MARKER-123456789");
    const p = new Uint8Array(1000);
    p.set(marker, 100);
    const ct = encryptSegment(s, k, "item", 0, 1, p.length, p);
    const hay = Array.from(ct).join(",");
    expect(hay.includes(Array.from(marker).join(","))).toBe(false);
  });

  test("wrong key, wrong item, wrong index, wrong count/total all fail", () => {
    const k = newItemKey(s);
    const p = plain();
    const ct = encryptSegment(s, k, "item", 0, 1, total, p);
    expect(() => decryptSegment(s, newItemKey(s), "item", 0, 1, total, ct)).toThrow();
    expect(() => decryptSegment(s, k, "other", 0, 1, total, ct)).toThrow();
    expect(() => decryptSegment(s, k, "item", 1, 1, total, ct)).toThrow();
    expect(() => decryptSegment(s, k, "item", 0, 2, total, ct)).toThrow();
    expect(() => decryptSegment(s, k, "item", 0, 1, total - 1, ct)).toThrow();
  });

  test("tampering, truncation and trailing data fail", () => {
    const k = newItemKey(s);
    const p = fill(3 * CHUNK + 5);
    const ct = encryptSegment(s, k, "item", 0, 1, p.length, p);
    const flipped = ct.slice();
    flipped[100] ^= 1;
    expect(() => decryptSegment(s, k, "item", 0, 1, p.length, flipped)).toThrow();
    expect(() => decryptSegment(s, k, "item", 0, 1, p.length, ct.subarray(0, ct.length - 1))).toThrow();
    // drop the last chunk entirely: declared length no longer matches
    const cut = ct.subarray(0, 24 + 3 * (CHUNK + 17));
    expect(() => decryptSegment(s, k, "item", 0, 1, p.length, cut)).toThrow();
    const extra = new Uint8Array(ct.length + 3);
    extra.set(ct);
    expect(() => decryptSegment(s, k, "item", 0, 1, p.length, extra)).toThrow();
  });

  test("segments cannot be swapped between positions of a multi-segment file", () => {
    const k = newItemKey(s);
    const total2 = SEG_PLAIN + 10;
    expect(segmentCount(total2)).toBe(2);
    const a = encryptSegment(s, k, "item", 0, 2, total2, fill(SEG_PLAIN));
    const b = encryptSegment(s, k, "item", 1, 2, total2, fill(10));
    expect(decryptSegment(s, k, "item", 0, 2, total2, a).length).toBe(SEG_PLAIN);
    expect(decryptSegment(s, k, "item", 1, 2, total2, b).length).toBe(10);
    expect(() => decryptSegment(s, k, "item", 1, 2, total2, a)).toThrow();
    expect(() => decryptSegment(s, k, "item", 0, 2, total2, b)).toThrow();
  });
});

describe("albums", () => {
  test("name round trip; bound to album id and key; padded", () => {
    const m = s.randombytes_buf(32);
    const a = encryptAlbumName(s, "Summer 2026", m, "album1");
    expect(decryptAlbumName(s, a, m, "album1")).toBe("Summer 2026");
    expect(() => decryptAlbumName(s, a, m, "album2")).toThrow();
    expect(() => decryptAlbumName(s, a, s.randombytes_buf(32), "album1")).toThrow();
    expect(encryptAlbumName(s, "x", m, "album1").length).toBe(a.length);
  });
});

describe("recovery key rotation", () => {
  test("new key unlocks the same master key; the old key no longer matches the verifier", async () => {
    const acc = await createAccount(s, EMAIL, "rotate-password-1", fast());
    const kit = await newRecoveryKit(s, EMAIL, acc.masterKey);
    expect(kit.words).not.toEqual(acc.recoveryWords);
    const p = await recoveryProof(s, kit.words.join(" "));
    expect(p.recovery_auth).toBe(kit.recovery_verifier);
    expect(unlockWithRecovery(s, EMAIL, p.recWrap, kit.wrapped_master_recovery)).toEqual(acc.masterKey);
    const old = await recoveryProof(s, acc.recoveryWords.join(" "));
    expect(old.recovery_auth).not.toBe(kit.recovery_verifier);
    expect(() => unlockWithRecovery(s, EMAIL, old.recWrap, kit.wrapped_master_recovery)).toThrow();
  });
});

describe("item keys sealed by the background backup", () => {
  test("open with the account key pair, only for their own item", async () => {
    const { accountKeyPair, openSealedItemKey, sealItemKey, unwrapAnyItemKey, wrapItemKey, SEALED_ITEM_KEY_LEN } = await import("./item");
    const { createAccount } = await import("./account");
    const { newKdfParams } = await import("./kdf");
    const s = await getSodium();
    const acct = await createAccount(s, "a@b.org", "pw pw pw pw", newKdfParams(s, 2, 32 * 1024 * 1024));
    const id = "0123456789abcdef0123456789abcdef";
    const key = s.randombytes_buf(32);
    const pk = s.from_base64(acct.bundle.pubkey, s.base64_variants.URLSAFE_NO_PADDING);
    const sealed = sealItemKey(s, key, pk, id);
    expect(sealed.length).toBe(SEALED_ITEM_KEY_LEN);
    const pair = accountKeyPair(s, s.from_base64(acct.bundle.wrapped_privkey, s.base64_variants.URLSAFE_NO_PADDING), acct.masterKey, "a@b.org");
    expect(s.memcmp(pair.pk, pk)).toBe(true);
    expect(s.memcmp(openSealedItemKey(s, sealed, pair, id), key)).toBe(true);
    expect(() => openSealedItemKey(s, sealed, pair, "f" + id.slice(1))).toThrow();
    // both kinds through one call; the key pair is only opened for a sealed one
    let asked = 0;
    const ask = () => { asked++; return pair; };
    expect(s.memcmp(unwrapAnyItemKey(s, wrapItemKey(s, key, acct.masterKey, id), acct.masterKey, ask, id), key)).toBe(true);
    expect(asked).toBe(0);
    expect(s.memcmp(unwrapAnyItemKey(s, sealed, acct.masterKey, ask, id), key)).toBe(true);
    expect(asked).toBe(1);
  }, 60_000);
});

describe("search index", () => {
  test("entries are sealed to the account and bound to their item; the people list to the account", async () => {
    const { accountKeyPair } = await import("./item");
    const { openIndexEntry, sealIndexEntry, encryptPeople, decryptPeople } = await import("./search");
    const s = await getSodium();
    const acct = await createAccount(s, "a@b.org", "pw pw pw pw", newKdfParams(s, 2, 32 * 1024 * 1024));
    const pk = unb64(s, acct.bundle.pubkey);
    const pair = accountKeyPair(s, unb64(s, acct.bundle.wrapped_privkey), acct.masterKey, "a@b.org");
    const id = "0123456789abcdef0123456789abcdef";
    const entry = { v: 1 as const, m: "test", clip: "AAAA", faces: [{ box: [0.1, 0.2, 0.3, 0.4], score: 0.9, emb: "BBBB" }] };
    const blob = sealIndexEntry(s, entry, pk, id);
    expect((blob.length - 1 - 48 - 16) % 512).toBe(0); // padded: the size says little about the faces in it
    expect(openIndexEntry(s, blob, pair, id)).toEqual(entry);
    expect(() => openIndexEntry(s, blob, pair, "f" + id.slice(1))).toThrow();
    const other = await createAccount(s, "c@d.org", "pw pw pw pw", newKdfParams(s, 2, 32 * 1024 * 1024));
    const otherPair = accountKeyPair(s, unb64(s, other.bundle.wrapped_privkey), other.masterKey, "c@d.org");
    expect(() => openIndexEntry(s, blob, otherPair, id)).toThrow();
    const people = { v: 1, people: [{ id: "p1", name: "Anna", anchors: ["x:0"], rejects: [] }] };
    const enc = encryptPeople(s, people, acct.masterKey, "u1");
    expect(decryptPeople(s, enc, acct.masterKey, "u1")).toEqual(people);
    expect(() => decryptPeople(s, enc, acct.masterKey, "u2")).toThrow();
  }, 60_000);
});
