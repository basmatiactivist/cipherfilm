# CRYPTO.md (draft v1)

All cryptography uses **libsodium** (WASM in the browser: the standard build on the main thread, the sumo build with Argon2 only in the sign-in worker; native libsodium in the Android and Mac apps). No custom primitives; the only "construction" is composition of libsodium calls described here. The server uses `golang.org/x/crypto/argon2` only to hash the already-derived auth key.

Notation: `||` concat; `KDF(key, ctx, id)` = `crypto_kdf_derive_from_key(32, id, ctx[8], key)`; `AEAD` = `crypto_aead_xchacha20poly1305_ietf` (random 24-byte nonce, prepended); `SS` = `crypto_secretstream_xchacha20poly1305`.

## 1. Key hierarchy

```
password ──Argon2id(salt, params)──► root (32 B) ──KDF(root,"AUTHKEY1",1)──► authKey -> server stores argon2id(authKey)
                                              └──KDF(root,"KEKWRAP1",2)──► KEK     -> wraps masterKey

recoveryKey (32 random B, shown as 24 words)
   ├─► recoveryAuth = KDF(recoveryKey, "RECAUTH1", 1)   -> server stores argon2id(recoveryAuth)
   └─► recoveryKEK  = KDF(recoveryKey, "RECWRAP1", 2)   -> wraps masterKey

masterKey (32 random B)
   ├─► wrapped by KEK            (wrapped_master_pw)
   ├─► wrapped by recoveryKEK    (wrapped_master_recovery)
   ├─► wraps X25519 secret key   (wrapped_privkey)   [future sharing, unused in v1]
   ├─► albumKey / album name key = KDF(masterKey, "ALBUMNAM", 0)
   └─► wraps each itemKey        (wrapped_item_key)

itemKey (32 random B per item)
   ├─► metaKey    = KDF(itemKey, "ITEMMETA", 0)   encrypts metadata JSON (AEAD)
   ├─► thumbKey   = KDF(itemKey, "ITEMTHMB", 0)   encrypts thumbnail
   ├─► prevKey    = KDF(itemKey, "ITEMPREV", 0)   encrypts preview
   └─► segKey[i]  = KDF(itemKey, "ITEMSEGM", i)   one SS stream per 4 MiB segment
```

The recoveryKey is high-entropy, so it is not stretched; its verifier is still hashed server-side so a DB leak does not reveal a usable `recoveryAuth`.

## 2. Password hashing

- Argon2id via `crypto_pwhash` (`ALG_ARGON2ID13`), 32-byte output (then split with `crypto_kdf`), salt 16 random bytes per user.
- Default params: `opslimit=3`, `memlimit=64 MiB`, tuned at M2 on a mid-range phone to ~1-2 s; stored per user as `{alg, ops, mem, salt, v}` and are meant to be raised on a later login if below the current minimum (not yet implemented; the client does refuse KDF settings outside the server's own range, ops 2-10 and 32 MiB-1 GiB) (client re-wraps and uploads new `auth`).
- Server-side: `argon2id(authKey, serverSalt, t=2, m=32 MiB, p=1)`; compared in constant time. Unknown e-mails get a deterministic fake salt (`HMAC(serverSecret, email)`) and the same timing path, to resist enumeration.

## 3. Wrapping format

`wrapped = 0x01 || nonce(24) || AEAD(plaintext=key, ad=ctx || 0x00 || owner, key=wrapper)`

`ctx` is a fixed ASCII label per slot (e.g. `"wrap/master/pw"`) and `owner` is the normalised e-mail for account keys (immutable in v1) or the item id for item keys, so a wrapped blob cannot be replayed in another slot or for another owner. Versioned by the first byte.

**Item keys from the Android background backup (version 2).** The background has no master key, so it seals each new item key to the account's X25519 public key instead:

`wrapped = 0x02 || crypto_box_seal(plaintext = itemKey(32) || itemId(16 raw bytes), pk)` (97 bytes)

The item id inside the sealed plaintext binds the key to its item, as the AD does for version 1. The app pins `pk` when backup is turned on, after checking it equals `scalarmult_base(sk)` for the private key it opens with the master key, so a server that later swaps the stored public key cannot redirect new uploads to a key of its own. The Mac app's watched folders use the same format. Readers (web, Android, Mac, `cipherfilm-decrypt`, `cipherfilm-upload`) open such keys with the private key from `wrapped_privkey` and compute the public half themselves. Consequence: the backup can add items but read none. The same is true of anyone who holds the public key — including the server — so the server could insert items into a library (it still cannot read any); this is the price of uploading without the master key. Test vector: `tools/decrypt/testdata/vectors.json` (`sealed`).

### Search index entries and the people list

Index entries (what the phone found in a photo) use the sealed format too, with the item id inside:
`0x02 ‖ crypto_box_seal(item id (16 bytes) ‖ sodium_pad(JSON, 512), account public key)`. Readers open them with the
account's private key and reject an entry whose id differs from the item's. The people list (names) is
`seal(pad(JSON, 1024), kdf(master, "PEOPLEST", 0), "blob/people", user id)`. The Android app keeps the opened index
between unlocks in its cache, encrypted with AEAD under `KDF(master, "IDXCOPY1", 1)` with
`ad = "cipherfilm search index copy v1|" ‖ user id ‖ "|" ‖ model family`, and deletes it at sign-out. Details:
docs/SEARCH.md.

## 4. File (item) format

Plaintext file is cut into **segments of 4 MiB** (last one shorter). Each segment is an independent libsodium secretstream under `segKey[i]`:

```
segment_i = SS.header(24) || SS.chunk_0 || SS.chunk_1 || ...
chunk plaintext size = 64 KiB (last chunk of the segment carries TAG_FINAL)
ad for every chunk = "seg" || itemId || u32(i) || u32(segment_count) || u64(total_size)
```

- Binding `i`, `segment_count`, `total_size` and the item id into the AD means segments cannot be reordered, dropped, duplicated, truncated or moved between items without an authentication failure. `TAG_FINAL` per segment catches truncation within a segment.
- The authoritative `total_size` also lives in the encrypted metadata and the client rejects an item whose server-declared size differs; `segment_count` is bound through the associated data and must equal `ceil(total_size / 4 MiB)` (at least 1).
- Independent segments give: parallel and resumable upload, retry per segment, and random access (a Range request maps to segment + chunk offsets, so video seeking works).
- Thumbnail and preview: single-shot AEAD, `ad = "thumb"|"preview" || itemId` (single-shot AEAD via the wrap format, so the label and owner are joined with a NUL byte).
- Metadata: JSON (`name`, `mime`, `capture_ts`, `width`, `height`, `duration`, GPS, EXIF subset, `size`, `segment_count`, `content_hash`) padded to a multiple of 256 B (small leak reduction), single-shot AEAD under `metaKey`, `ad = "meta" || itemId`.
  Edits (docs/EDITING.md) add the optional `edit` (turn, crop, picture version) and `orig` (date and place before the
  person changed them); the thumbnail and preview made for an edit replace the old ones under the same subkeys and `ad`.

Failure policy: any AEAD failure aborts decryption for that object, nothing is rendered, and the UI shows a "could not be verified" placeholder.

## 5. Authentication and sessions

- Login: `POST auth` with `authKey`; server verifies, issues a random 256-bit session token in an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie (`__Host-` prefix). Only `SHA-256(token)` is stored. CSRF: double-submit token derived per session plus a required custom header and Origin check.
- Two-step sign-in (optional, server/twofactor.go): for such an account the password step answers 401 `two_factor_required` with only a pending token (random 256 bits, stored as SHA-256 in memory, 5 minutes, single use); `POST /api/auth/login/2fa` with that token and a TOTP code (RFC 6238: HMAC-SHA-1, 6 digits, 30 s, ±1 step, each step accepted once) or a recovery code (80 random bits; stored as `HMAC-SHA256(HMAC(serverSecret, label), user id ‖ code)`) then issues the session and the bundle below. The client keeps the `KEK` derived in the password step in memory until then and zeroes it on success, on "start over" and on expiry. The TOTP secret is stored as `AES-256-GCM(key = HMAC(serverSecret, label), ad = "totp|" ‖ slot ‖ "|" ‖ user id)`. None of this touches the key hierarchy: two-step sign-in guards the session, not the keys.
- Passkeys (server/passkeys.go, WebAuthn via go-webauthn) are the same kind of second step: `POST /api/auth/login/2fa/passkey` with the pending token returns a challenge (32 random bytes) bound to that pending sign-in, and `POST /api/auth/login/2fa` with the token and the passkey's assertion (signed over the relying party id = the server's name and the challenge, origin `https://<name>` or the Android app's `android:apk-key-hash:<SHA-256 of its signing certificate>`) issues the session. The credential record (public key, signature counter, transports, AAGUID, flags) is stored as `AES-256-GCM(key = HMAC(serverSecret, "cipherfilm passkey at rest v1"), ad = "passkey|" ‖ user id ‖ "|" ‖ credential id)`. No PRF/hmac-secret or largeBlob is asked for: a passkey never derives or unwraps a key, and the password remains the only way to the `KEK`.
- The server returns `wrapped_master_pw`; the browser derives `KEK` from the password again and unwraps. A wrong password fails at Argon2/AEAD locally, and also at server-side auth.
- Password change: verify current, derive new `authKey`/`KEK` with a fresh salt, re-wrap `masterKey`, upload, invalidate other sessions. Data is not re-encrypted.
- Recovery: user enters e-mail + 24 words; client derives `recoveryAuth`, server verifies, returns `wrapped_master_recovery`; client unwraps `masterKey`, sets a new password (new salt, new wrap), and **rotates the recovery key** (new `wrapped_master_recovery` + new verifier) shown once again.

## 6. Session key storage (web)

`masterKey` lives in the page's memory (`web/src/state.ts`, on the main thread), never in storage in the clear. To
survive a reload of the same tab (`web/src/keep.ts`), it is encrypted at unlock with AES-256-GCM under a random,
non-extractable WebCrypto key that the browser keeps in IndexedDB (one per account, the user id as associated data);
the ciphertext goes into `sessionStorage`, which belongs to that tab only. A reload finds both and checks that the key
opens the account's private key before using it; a new tab finds no ciphertext and asks for the password. Because a
browser gives a reopened tab or a restored session its `sessionStorage` back, the ciphertext counts only for a real
reload: the browser reports the navigation as a reload and the page was left (pagehide) less than 30 seconds before.
Anything else (a reopened or restored tab, typing the address or a bookmark, going back to the app from another site
when the browser didn't keep the page, a phone browser reloading a tab it had dropped) asks for the password. Lock deletes the ciphertext; sign-out, an ended session and a sign-out from another device delete the
IndexedDB keys of every account as well. A key that is still being stored when the tab locks is not written.

## 7. Randomness and memory hygiene

`randombytes_buf` only. Keys are `Uint8Array`, zeroed with `sodium.memzero` when dropped (best effort in JS). No keys in URLs, logs or `localStorage`.

## 8. Versioning and agility

Each blob carries a 1-byte version; each user row stores `kdf_params.v`. New versions are decoded alongside old ones. Algorithm changes re-wrap keys (cheap) and, if the file format changes, lazily re-encrypt per item in the background.

## 9. Test vectors and tests (M2)

Round trip at every layer; wrong key, flipped bit, swapped segment, truncated segment/stream, wrong item id must all fail; recovery and password change leave items readable; KDF contexts are unique (a test asserts no two labels collide).

## 10. Independent decryption (tools/decrypt)

`tools/decrypt` re-implements the decrypt side of this document in Go with no shared code, so a backup stays readable
without the app. Its tests decrypt `testdata/vectors.json`, which the app's own TypeScript code produced
(`web/src/crypto/vectors.gen.test.ts`), and they check that bit flips, other item ids, other total sizes and truncation are
rejected. Two details are easy to get wrong when implementing the format from scratch:

- `crypto_kdf_derive_from_key` is keyed BLAKE2b with the subkey id as the 16-byte *salt* (little endian, zero padded) and the
  8-byte context as the 16-byte *personalisation* (zero padded). Go's `x/crypto/blake2b` cannot set these; the tool uses `dchest/blake2b`.
- libsodium's secretstream pads the ciphertext before the Poly1305 length block with `(0x10 - 64 + mlen) & 0xf` zero bytes,
  which is `mlen & 0xf`, not the usual "round up to 16".
