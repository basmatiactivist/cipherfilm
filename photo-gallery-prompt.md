# Claude Code prompt: private end-to-end encrypted photo gallery

> **Historical:** the prompt the project was started from. It is kept for the record and no longer describes the
> project; for what Cipherfilm is now, see the README and docs/.

## Step 0: do this yourself before pasting the prompt

1. Create an empty project folder, run `git init` in it, and start Claude Code there.
2. Install the Cloudflare security-audit skill (needs Node.js):
   ```
   npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit
   ```
   If it asks which agent to install for, pick Claude Code (`npx skills --help` shows the options).
3. Install Impeccable. Inside Claude Code run `/plugin marketplace add pbakaus/impeccable`, then open `/plugin` and install Impeccable.
   Alternatively, run `npx impeccable install` in the project root and accept the design hook.
   Optional, for privacy: `npx impeccable telemetry off`.
4. Restart Claude Code. Type `/impeccable` and check that it lists its commands.
5. Make sure OrbStack is running.
6. You only need this at deploy time: in the Tailscale admin console, enable MagicDNS and HTTPS certificates, and create an auth key.

---

## Prompt: paste everything below this line

You're building a small, self-hosted photo and video gallery with **end-to-end encryption**. Everything is encrypted in the browser before upload, and the server only ever stores ciphertext. Read this whole brief before doing anything.

**Golden rule:** if something isn't specified here and the choice matters (security, data model, UX, anything hard to change later), **ask me instead of guessing**. Collect open questions and ask them in batches. Don't stop for trivia.

### Context
- **Users:** me (the admin) plus a few family members and friends. Each person has a fully private library. There is no sharing between users in v1.
- **Production:** one small Linux VPS (plan for 1–2 vCPUs, 2 GB RAM, HDD storage). It is reachable **only via Tailscale**, with no public ports.
- **Local development and testing:** my Mac, with **OrbStack** (already installed) as the Docker runtime.
- **Expected size:** about 100 GB of photos and videos to start.
- **UI language:** English.

### Must-have features
1. **Client-side encryption in the browser.** Requirements are in the next section.
2. **User management with email + password.** No 2FA for now. The email is only the login name: the app never sends email and needs no SMTP.
   - Only the admin can create accounts. There is no public sign-up.
   - On a fresh install, the first admin is created through a one-time setup flow, protected by a setup token printed in the container logs.
   - The admin creates an invite for an email address. This produces a one-time, expiring invite link that the admin hands over manually. The invitee opens it and sets a password, and their browser generates their keys.
   - The admin can list, disable and delete accounts. The admin can **never** see anyone's photos, album names or metadata, including their own data through some admin path.
   - Logged-in users can change their password. This requires the current password.
3. **Recovery key.** When an account is created, show a recovery key once, with copy, download and print options and a "I've saved it" confirmation step. Email + recovery key lets a user set a new password **without losing data**. If both the password and the recovery key are lost, the data is gone, and the UI must say so plainly. There is no other recovery path, and no admin reset that could decrypt data.
4. **Media types:** JPEG, PNG, WebP, HEIC (iPhone) and videos (MP4/MOV). Originals are stored encrypted and byte-for-byte unchanged.
5. **Albums:** create, rename, delete, and add or remove items. Ask me whether one item can be in several albums, and what deleting an album does to its items.
6. **Gallery:** a fast grid of decrypted thumbnails with lazy loading and virtualization, a lightbox with keyboard and swipe navigation, and video playback.

### Also in v1
- **Timeline by capture date.** Read EXIF and video metadata in the browser and store it encrypted. Fall back to the file date when there's no metadata.
- **Download originals.** Support single items and whole albums as a ZIP. Decryption and zipping happen in the browser as a stream, so multi-GB albums must not crash the tab.
- **Trash.** Deleted items stay in the trash for 30 days and can be restored. After that they are purged, including the encrypted blobs on disk.
- **Phone-friendly.** The UI is fully responsive, and uploading from a phone browser works well, including large videos.

### Out of scope for v1
2FA, sharing between users, public links, face recognition or other ML, native mobile apps, automatic phone backup, sending email, and server-side image or video processing (the server can't see the content anyway).

### Encryption requirements
These properties must hold:
- The server never receives the plaintext of file contents, thumbnails, filenames, EXIF/metadata (including GPS), capture dates or album names. It also never receives the user's password or any key that can decrypt.
- Use well-reviewed libraries only (libsodium or WebCrypto). **No custom crypto primitives and no homemade constructions.**
- Use authenticated encryption everywhere. Tampered or swapped data must fail loudly and must not be displayed.
- Encrypt large files in chunks (e.g. libsodium secretstream), so uploads are chunked and resumable and memory use stays bounded on phones.

Suggested design (confirm it or argue against it in your plan):
- Run the password through Argon2id. Tune the parameters so it takes about 1–2 seconds on a mid-range phone, and store them per user so they can be raised later. Derive **two separate subkeys**: an authentication key (the server stores only a hash of it) and a key-encryption key.
- Give each user a random **master key**, wrapped by the key-encryption key and, separately, by the recovery key. A password change or recovery only re-wraps the master key.
- Give each item a random key, wrapped by the master key. Thumbnails and metadata are encrypted the same way.
- Consider giving each user a keypair now, so sharing could be added later without re-encrypting everything. Don't build sharing.
- Decide with me where the master key lives during a session (memory only, or something that survives a reload), and explain the trade-off.

Write `docs/CRYPTO.md` (key hierarchy, algorithms, parameters, formats, versioning) and `docs/THREAT_MODEL.md`. The threat model must be honest about the limits of encryption in a web app: whoever controls the server can serve malicious JavaScript. Mitigate this with a strict CSP (no inline scripts, no third-party origins), self-hosted assets only (no CDNs, external web fonts, analytics or telemetry), and few pinned dependencies. Also list what the server still learns: emails, file counts, sizes and upload times.

Known media pitfalls. Propose solutions in your plan:
- Chrome and Firefox can't decode HEIC natively. Use an in-browser (WASM) decoder for thumbnails and previews. The original stays HEIC.
- Video thumbnails: grab a frame in the browser.
- iPhone HEVC `.mov` files may not play in every browser, and the server can't transcode them. Play the video when the browser supports it, and otherwise show a clear "download to play" fallback. Don't try ffmpeg.wasm transcoding without asking me.
- Playing encrypted videos: prefer progressive decryption (e.g. with a Service Worker). If you propose decrypting the whole file first, state the size limit.

### Tech & deployment
- **You choose the stack** and justify it in the plan. Priorities are a small memory footprint (it must run comfortably on 2 GB RAM alongside Tailscale), few dependencies, and long-term maintainability. Prefer an embedded database such as SQLite unless you have a strong reason not to.
- **Docker Compose:** multi-stage builds, non-root containers, read-only root filesystem where possible, healthchecks. Images must build for **linux/amd64 and linux/arm64**, so they run both on my Mac and on the VPS.
- **Storage:** the encrypted blobs and the database live on a local Docker volume. Document a backup and restore procedure.
- **Production compose:** run the official Tailscale container as a sidecar and let the app share its network namespace. Provide HTTPS through **Tailscale Serve**, and publish **no ports on the host**. Configure it via `.env` (auth key, hostname). Document the tailnet prerequisites (MagicDNS and HTTPS certificates enabled). Check Tailscale's current docs for the exact config instead of relying on memory.
- **Local dev compose (OrbStack on my Mac):** no Tailscale. Use OrbStack's automatic HTTPS on `*.orb.local` domains so the browser treats the app as a secure context, which the crypto APIs require (see https://docs.orbstack.dev/features/https). Provide one command to start and one to reset everything.
- **Session security:** httpOnly, Secure and SameSite cookies; CSRF protection; login rate limiting; security headers; upload size and per-user quota limits.

### Skills: use both (they're installed)

**Impeccable (design):**
1. Before writing any UI code, run `/impeccable init`. It will interview me and write `PRODUCT.md`. Then run `/impeccable shape` for these flows: first-admin setup, invite acceptance with the recovery-key screen, login, account recovery, upload, timeline/gallery, album view, lightbox, trash and admin.
2. While building, use its steer commands (`typeset`, `layout`, `quieter`, etc.) where they help.
3. Before calling the UI done, run `critique`, `audit`, `adapt` (phones and tablets), `onboard` (empty states and first run), `harden` (errors, long names, slow networks, failed decryption), `optimize` and finally `polish`. Fix what they find.
4. Use `live` mode only against the local checkout.

**Cloudflare security-audit:**
1. After the feature-complete milestone, run a full audit ("security audit this codebase"). It needs an OS-enforced sandbox to run code. If your environment doesn't provide one, tell me before you start the audit, because findings will then stay `needs_validation`.
2. Ask it to focus especially on the crypto implementation, authentication and sessions, the invite, setup and recovery flows, access control between users (IDOR, at the API level too), upload handling and the CSP.
3. Fix every confirmed finding, then run the audit **at least once more**, since repeated runs find more. Summarise `REPORT.md` and `NEEDS-VALIDATION.md` for me.

### Process
1. **Plan first.** Write `PLAN.md` (architecture, stack choice with reasons, data model, API outline, milestones), `docs/CRYPTO.md`, `docs/THREAT_MODEL.md` and a list of open questions. **Then stop and wait for my approval.** Write no app code before that.
2. **Build in milestones.** Each milestone ends in a working state on OrbStack, with tests passing and a git commit:
   - M1: skeleton, dev compose on OrbStack, a single test command
   - M2: crypto core; setup, admin, invites, login, recovery and password change
   - M3: chunked, resumable encrypted upload; thumbnails; HEIC
   - M4: gallery, timeline, lightbox, albums
   - M5: video
   - M6: download and ZIP, trash and purge, admin user management
   - M7: production compose with Tailscale, plus the README
   - M8: Impeccable design pass, then the security audit and fixes
3. **Testing:**
   - Crypto unit tests: round trips; a wrong key or tampered ciphertext must fail; recovery and password change must keep data readable.
   - A test that uploads known files and asserts that nothing the server stores (database and blobs) contains their plaintext bytes, filenames or EXIF strings.
   - Playwright end-to-end tests against the OrbStack stack covering all the flows above, including a phone viewport. A second user must not be able to access the first user's items, through the UI or the API.
4. After each milestone, give me a short summary: what changed, how to try it on OrbStack, and any new open questions.

### Definition of done
- `docker compose up` on OrbStack gives a working app at an `https://….orb.local` URL.
- The production compose file and the README let me deploy to a fresh VPS reachable only via Tailscale. The README covers prerequisites, `.env`, first-admin setup, inviting users, backup and restore, and updating.
- All tests pass. A repeated security audit shows no open confirmed findings, and the issues from Impeccable's critique and audit are addressed.
