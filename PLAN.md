# PLAN: private end-to-end encrypted photo gallery

Status: **historical planning document** from before the build (milestones M1 to M8 are done; the current release is listed in CHANGELOG.md). The implemented system is described in the README, docs/SELF-HOSTING.md, docs/CRYPTO.md and docs/THREAT_MODEL.md and differs in details, for example in the Android and Mac apps, on-device search, deployment behind any HTTPS reverse proxy, and sessions that last 30 days from their last use.
Companion docs: [docs/CRYPTO.md](docs/CRYPTO.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## 1. Stack and reasons

| Layer | Choice | Why |
|---|---|---|
| Server | **Go** (stdlib `net/http`, one static binary) | ~15-30 MB RSS idle, trivial cross-compile to amd64/arm64, tiny distroless/scratch image, very few deps, long-term stable. |
| DB | **SQLite** via `modernc.org/sqlite` (pure Go, no CGO) | Embedded, WAL mode, one file, easy backup. Pure Go keeps multi-arch builds simple. |
| Blob store | Plain files on the volume, random 128-bit IDs, sharded dirs | Server only sees opaque ciphertext. `fsync` on finalize; atomic rename. |
| Frontend | **TypeScript + Vite + Preact** (plain CSS, no UI framework) | ~4 KB runtime, easy to audit, strict CSP friendly (no inline scripts), static build served by the Go binary via `embed`. |
| Crypto | **libsodium-wrappers-sumo** (WASM, self-hosted) | Argon2id, XChaCha20-Poly1305, secretstream, KDF, sealed boxes, X25519. One audited library for everything. WebCrypto is used only for the optional "remember this device" non-extractable key. |
| HEIC | `libheif-js` WASM, lazy-loaded in a Web Worker | Only fetched when a HEIC is first seen. Originals stay HEIC. |
| Metadata | `exifr` (EXIF/GPS/dates), small MP4/MOV `mvhd`/`mdat` reader for video | Runs in the browser; output encrypted. |
| ZIP streaming | `client-zip` (tiny, streaming, store-only) | Multi-GB ZIPs via `ReadableStream` -> File System Access API or Service Worker download. No compression (photos/videos don't compress). |
| Tests | Go `testing`; Vitest for crypto/units; Playwright for e2e | Single `make test`. |
| Container | Multi-stage, distroless `nonroot`, read-only rootfs, tmpfs `/tmp`, healthcheck via `app healthcheck` subcommand | |

Total pinned runtime deps on the client: libsodium-sumo, preact, exifr, libheif-js, client-zip. Server: modernc sqlite, `golang.org/x/crypto` (argon2 for server-side hashing of the auth key), and little else (own CSRF, rate limiter, sessions in SQLite).

Rejected alternatives: Node/Rails servers (higher RAM, bigger dep trees), Postgres (needless on 2 GB), OPAQUE (see open question Q3), Next.js/SSR (nothing to render server-side, since the server can't see content).

## 2. Architecture

```
Browser (all crypto)  <--HTTPS (Tailscale Serve / OrbStack)-->  Go app  -->  SQLite + /data/blobs
  main thread: UI, session key in memory
  Worker(s): chunk encrypt/decrypt, Argon2id, HEIC decode, thumbnailing
  Service Worker: /sw/stream/<itemId> progressive video decrypt + ZIP/download streams
```

- The server is a dumb, authenticated, quota-enforcing blob and row store. It cannot interpret any content.
- Every API object is owned by exactly one user; every query is scoped by the session's `user_id` (no cross-user ID lookups, 404 not 403).
- Frontend is a static SPA embedded in the binary; strict CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Plus HSTS, `Referrer-Policy: no-referrer`, `X-Content-Type-Options`, COOP/CORP, `Permissions-Policy`.

## 3. Data model (server, SQLite)

All `*_enc` / `wrapped_*` columns are opaque blobs with a leading format-version byte.

```
users(id, email_norm UNIQUE, role[admin|user], status[active|disabled],
      kdf_params, kdf_salt,
      auth_hash,                 -- argon2id(server_side, authKey)
      pubkey,                    -- X25519 (future sharing)
      wrapped_master_pw,         -- masterKey wrapped by KEK
      wrapped_master_recovery,   -- masterKey wrapped by recovery key
      wrapped_privkey,           -- X25519 secret wrapped by masterKey
      recovery_verifier,         -- argon2id(server_side, recoveryAuth)
      quota_bytes, created_at)
invites(id, token_hash, email_norm, created_by, expires_at, used_at)
setup_state(done, token_hash)
sessions(id_hash, user_id, created_at, expires_at, csrf_secret, ua_hash)
items(id, user_id, kind[image|video], wrapped_item_key, meta_enc, thumb_blob_id,
      preview_blob_id, blob_id, size_bytes, segment_count,
      sort_ts,                    -- see Q5 (timeline ordering)
      created_at, trashed_at NULL)
albums(id, user_id, name_enc, wrapped_album_key?, created_at)
album_items(album_id, item_id, added_at, wrapped_entry?)
uploads(id, user_id, item_id, expected_size, received_segments bitmap, state, expires_at)
audit_log(ts, user_id, action)    -- no content, no IPs beyond rate-limit window
```

Server-visible: email, role, sizes, counts, timestamps, album membership structure (unavoidable for server-side relations unless we encrypt membership too, see Q4/Q5).

## 4. API outline (JSON unless noted; all but `/auth/*`, `/setup`, `/invites/accept` need session + CSRF header)

```
POST /api/setup                    {setup_token, email, kdf, auth, wrapped_*, pubkey, recovery_verifier}
GET  /api/auth/params?email=       -> kdf params + salt (deterministic fake for unknown emails)
POST /api/auth/login               {email, auth}      -> sets cookie; returns wrapped_master_pw, wrapped_privkey, kdf
POST /api/auth/logout
POST /api/auth/password            {current_auth, new_auth, new_kdf, new_wrapped_master_pw}
POST /api/auth/recover             {email, recovery_auth, new_auth, new_kdf, new_wrapped_master_pw, new_wrapped_master_recovery?}
GET  /api/invites/{token}          -> email, kdf defaults
POST /api/invites/{token}/accept   {auth, kdf, wrapped_*, pubkey, recovery_verifier}
admin: GET/POST /api/admin/users, POST /api/admin/invites, PATCH/DELETE /api/admin/users/{id}
items: GET /api/items?cursor=      -> rows (encrypted meta) for client-side decrypt/group
       POST /api/uploads           {size, segment_count, wrapped_item_key, meta_enc...}
       PUT  /api/uploads/{id}/segments/{n}   (octet-stream, idempotent, resumable)
       POST /api/uploads/{id}/finalize  {thumb, preview, meta_enc}
       GET  /api/items/{id}/blob   (Range supported; ciphertext)
       GET  /api/items/{id}/thumb | /preview
       POST /api/items/thumbs {item_ids}       (up to 100 thumbnails in one response: u32 length + bytes each)
       POST /api/items/{id}/trash | /restore ; DELETE (purge)
albums: CRUD + POST/DELETE /api/albums/{id}/items
GET  /api/me/usage ; GET /healthz
```

## 5. Key design decisions to confirm (details in CRYPTO.md)

1. Argon2id (client) -> 64 bytes -> split via `crypto_kdf` into `authKey` and `KEK`. Server stores `argon2id(authKey)` again with its own salt; a DB leak does not allow offline guessing of the password faster than the client KDF cost.
2. Random 32-byte `masterKey` wrapped by `KEK` and by `recoveryKey` (XChaCha20-Poly1305). Password change or recovery re-wraps only.
3. Random per-item key wrapped by `masterKey`. Thumbnails, previews and metadata encrypted under keys derived from the item key.
4. X25519 keypair per user, secret key wrapped by `masterKey`, for future sharing only.
5. **File format:** files are split into 4 MiB *segments*; each segment is an independent libsodium `secretstream` (64 KiB chunks) under a subkey `crypto_kdf(itemKey, segmentIndex)`. This keeps resumable upload, parallel upload and **random access** (video seeking via Range requests in a Service Worker) while only using libsodium primitives. Segment count and total size are authenticated inside the encrypted header, so truncation, reordering and swapping are detected.

## 6. Media pitfalls: proposed solutions

- **HEIC:** WASM decode in a Worker for thumbnail (320 px) and preview (~2048 px, JPEG/WebP re-encoded in browser, stored encrypted). Original untouched.
- **Video thumbs:** hidden `<video>` + canvas frame at ~1 s from a decrypted object URL of the first segment(s); fallback to a generic icon if the codec can't decode.
- **HEVC .mov:** feature-test with `canPlayType`/`MediaCapabilities`; if unsupported show "can't play in this browser, download to play". No ffmpeg.wasm.
- **Video playback:** Service Worker handles `GET /sw/stream/{id}`, translates Range requests to segment fetches and decrypts progressively. Fallback when SW is unavailable (e.g. first load before activation): decrypt-to-Blob up to a 512 MB limit, else offer download. iOS Safari needs byte-range responses; the SW supports this.
- **Large uploads on phones:** read via `Blob.slice` per segment, encrypt in a Worker, PUT with retry. Memory stays bounded to ~2 segments. Uses Screen Wake Lock where available; resumes on reload by asking the server which segments exist.

## 7. Deployment

- `compose.dev.yaml` (OrbStack): app only, labelled `dev.orbstack.domains=photos.orb.local` for automatic HTTPS. `make up` / `make reset`. Verify the label mechanism against the OrbStack docs at M1.
- Production: `compose.yaml`, the app on `127.0.0.1:8080` behind any HTTPS reverse proxy the operator runs (since the release after 2.1.7; M7 shipped one overlay each for Tailscale, an own proxy and Caddy). Originally: `tailscale` sidecar (`TS_AUTHKEY`, `TS_HOSTNAME`, `TS_SERVE_CONFIG` for Serve -> `http://127.0.0.1:8080`), app with `network_mode: service:tailscale`, **no `ports:`**. Exact serve config and env names checked against current Tailscale docs at M7.
- Volumes: `appdata` (SQLite + blobs), `tsstate`. Backup: SQLite `VACUUM INTO`/`.backup` plus blob dir snapshot (rsync), documented with restore steps. Blobs are written before DB commit and orphan-swept, so a consistent backup is "DB first, then blobs".
- Multi-arch via `docker buildx --platform linux/amd64,linux/arm64`.
- Limits: per-user quota, max segment size, request body caps, login rate limit (per IP and per account, in memory: resets on restart), session idle and absolute expiry, trash purge job (daily, deletes blobs from disk).

## 8. Milestones

| M | Scope | Done when |
|---|---|---|
| M1 | Repo skeleton, Go server hello, Vite app, `compose.dev.yaml` on OrbStack, `make test/up/reset`, CI-less single test command | https URL on `*.orb.local` loads; test cmd green |
| M2 | Crypto core + tests; setup, invites, login, recovery, password change, admin basics, sessions/CSRF/rate-limit | Unit + e2e for auth flows; recovery keeps data readable |
| M3 | Segment format, chunked resumable upload, thumbnails, HEIC | Plaintext-leak test passes |
| M4 | Gallery grid (virtualized), timeline, lightbox, albums | e2e incl. isolation between two users |
| M5 | Video (SW streaming, fallbacks, thumbs) | Seek works; HEVC fallback shown |
| M6 | Download, ZIP streaming, trash, purge job, admin user mgmt | Multi-GB ZIP does not grow memory |
| M7 | Production compose, Tailscale, README, backup/restore docs | Dry run of prod compose with a throwaway tailnet key |
| M8 | Impeccable passes, then security audit x2+, fixes | See Definition of done |

UI work (M2 onward) is preceded by `/impeccable init` and `shape`.

## 9. Environment notes

- The `impeccable` and Cloudflare `security-audit` skills are **not present in this session's skill list**. Step 0 items 2-4 may not have taken effect here (or this session started before the restart). Needed before M2 (Impeccable) and M8 (audit). See Q1.
- The folder is not yet a git repo. Milestone commits need `git init` (Q2).
- The audit needs an OS-enforced sandbox; I'll check at M8 and tell you beforehand if there is none.

## 10. Open questions (please answer; defaults in bold are what I'll do if you say "go with your defaults")

**Blocking the start**
- **Q1. Skills:** Are Impeccable and security-audit installed for this project folder? Neither appears in my skill list. Should I proceed with M1 and wait for you to install them before M2? (**Yes.**)
- **Q2. Git:** OK for me to run `git init` in this folder and commit per milestone? (**Yes.**)
- **Q3. Auth scheme:** Argon2id-derived auth key with a server-side hash (simple, matches your brief), vs. OPAQUE (server never sees even the derived key; no mature audited JS library, so more risk). (**Simple scheme.**)
- **Q4. Master key lifetime:** (a) memory only: safest, but every reload/new tab asks for the password again; (b) memory plus optional "remember on this device", which stores the master key wrapped by a non-extractable WebCrypto key in IndexedDB (survives reloads, but anyone with the unlocked browser profile or an XSS can use it). (**(a) by default, (b) as an opt-in checkbox at login with a clear warning.**)

**Product / data model**
- **Q5. Albums:** Can one item be in several albums? (**Yes.**) Deleting an album removes only the album, never its items. Album names are encrypted. Album membership is visible to the server as rows (item id <-> album id); say if you want membership hidden too (costs: server can't count or paginate per album, client must download the whole membership list).
- **Q6. Timeline ordering:** Capture date is encrypted, so the server can't sort by it. (**The client loads all encrypted item records, ~1 KB each, and sorts and groups locally; fine up to tens of thousands of items.**) Alternative: store a coarse month bucket in plaintext, which leaks rough dates to the server.
- **Q7. Previews:** Store a ~2048 px encrypted preview per image (+~300 KB each) so the lightbox is fast and HEIC doesn't need WASM every time? (**Yes.**)
- **Q8. Duplicate uploads:** Detect duplicates client-side via an encrypted hash in metadata? (**Warn but allow; no server-side dedupe, which would leak equality.**)
- **Q9. Quota defaults:** per-user quota default? (**None for admin, 20 GB for users, editable per user.**) Max single file? (**8 GB.**)
- **Q10. Invite expiry and session lifetime:** (**Invite 7 days; session 14 days absolute, 24 h idle.**)
- **Q11. Recovery key format:** (**24 words from the BIP39 English list, 256-bit entropy plus checksum, easy to print and copy.**) Alternative: base32 groups. Your call.
- **Q12. Trash purge:** 30 days, daily job. Items in trash still count toward quota until purged. (**Yes.**)
- **Q13. ZIP:** browsers without the File System Access API (iOS Safari, Firefox) will stream through a Service Worker download; very large ZIPs on iOS may still be unreliable. Acceptable? (**Yes, documented limitation.**)
- **Q14. Admin self-service:** may the admin also have a photo library? (**Yes, same as any user; admin role only adds user management.**)
- **Q15. Concurrency:** one active session per user or many? (**Many, listable and revocable in settings.**)
