# Cipherfilm

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A small, self-hosted photo and video gallery with **end-to-end encryption**. Everything is encrypted in the
browser before it is uploaded; the server only ever stores ciphertext. Built for a family and a few friends:
the admin invites people, and each person has a fully private library. The admin cannot see anyone's photos,
album names or file names.

- Upload JPEG, PNG, WebP, HEIC and video (MP4/MOV/WebM). Originals are kept byte for byte.
- Timeline by capture date, albums, lightbox, video playback with seeking, ZIP downloads, trash (30 days).
- Works on phones and desktops: the web app, an Android app (`mobile/`) and a Mac app (`mac/`, [docs/MAC.md](docs/MAC.md))
  that keeps an export folder up to date, uploads watched folders and does search in the background.
- Search what's in your photos ("beach", "dog") and who is in them, on your own devices with open models; the server
  stores the results encrypted ([docs/SEARCH.md](docs/SEARCH.md)). Explicit search with an uncensored model is off
  until an admin allows it per person. Which models, from where, and what was checked: [docs/MODELS.md](docs/MODELS.md).
- Runs comfortably on a 1–2 vCPU / 2 GB machine (about 35 MB of RAM when idle).

**Read this first:** if a person loses *both* their password and their recovery key, their photos are gone.
Nobody can reset it, not even the admin. That is the point, and the app says so plainly.
How the encryption works, and what the server still learns, is in [docs/CRYPTO.md](docs/CRYPTO.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Please read the threat model: a web app can only protect you
from someone who controls the server if you trust the code the server delivers.

**Download and install** (server, web, Android, Mac, tools): [docs/INSTALL.md](docs/INSTALL.md).

## Requirements

- Docker with the Compose plugin (`docker compose`) on a Linux or macOS machine (amd64 or arm64).
- **HTTPS.** The browser's encryption features, the Service Worker (video, big downloads) and the secure
  session cookie all require a secure connection. Cipherfilm doesn't provide HTTPS itself; one of the three
  options below does.

## Choose how to deploy

Pick exactly one. They share one base file, [compose.yaml](compose.yaml), which runs only the app, publishes
**no ports**, runs read-only as a non-root user, and stores data in the Docker volume `cipherfilm_data`.

| Option | Who it is for | HTTPS from | Open ports on the host |
|---|---|---|---|
| **A. Tailscale** | Private use; reachable only by devices on your tailnet | Tailscale Serve | none |
| **B. Your own reverse proxy** | You already run nginx, Caddy, Traefik, a Cloudflare Tunnel, … | your proxy | `127.0.0.1:8080` only |
| **C. Caddy (bundled)** | A public site on your own domain | Let's Encrypt, automatic | 80 and 443 |

Copy [.env.example](.env.example) to `.env`, select the option with `COMPOSE_FILE`, fill in its settings,
then start it:

```bash
cp .env.example .env      # edit it
docker compose up -d --build
docker compose logs app | grep "FIRST-TIME SETUP"
```

### A. Tailscale

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns) turn on **HTTPS certificates**
   (and MagicDNS). Serve needs the certificates.
2. Create an **auth key** (Settings → Keys). A one-off key is enough: it is only used the first time
   (`TS_AUTH_ONCE=true`, and the node's state is kept in the `cipherfilm_tsstate` volume).
3. In `.env`: `COMPOSE_FILE=compose.yaml:compose.tailscale.yaml`, `TS_AUTHKEY=…`, `TS_HOSTNAME=photos`, and
   `PUBLIC_HOSTS=photos.<your-tailnet>.ts.net` (recommended: the app then refuses requests for any other name).
4. `docker compose up -d --build`. The site is at `https://photos.<your-tailnet>.ts.net`.

The app shares the Tailscale container's network, so nothing is published on the host.
[deploy/tailscale/serve.json](deploy/tailscale/serve.json) makes Tailscale Serve forward HTTPS to the app and
explicitly sets `AllowFunnel` to `false`, so it is never exposed to the public internet.

A name of your own (`photos.example.com`) works too, still only inside the tailnet: [docs/OWN-DOMAIN.md](docs/OWN-DOMAIN.md).

This option runs on a real Debian 13 VPS with the released image. After the first start,
`docker compose exec tailscale tailscale serve status` shows `https://<name>.<tailnet>.ts.net (tailnet only)`; the
first certificate takes a few seconds. Two things in the admin console afterwards: turn off **key expiry** for the
machine (otherwise it drops off the tailnet after about 180 days), and delete the used auth key. With this option the
host needs no open ports except SSH; see [docs/SERVER-HARDENING.md](docs/SERVER-HARDENING.md).

### B. Your own reverse proxy

1. `.env`: `COMPOSE_FILE=compose.yaml:compose.proxy.yaml`, `PUBLIC_HOSTS=photos.example.com` (the name your proxy
   serves; required) and optionally `APP_PORT=8080`.
2. Point your proxy at `http://127.0.0.1:8080`. Requirements:
   - **Forward `Host` and add `X-Forwarded-For`.** Login rate limits use the client address; with exactly one
     proxy in front, leave `TRUST_PROXY=1`. Behind a Cloudflare Tunnel or several proxies set
     `TRUST_PROXY=0`. Then every client looks like the same source, so a stranger's failed logins can block *new*
     browsers for up to 15 minutes; browsers that have signed in before are not affected (device cookie).
     `X-Forwarded-For` is only believed for requests to a name in `PUBLIC_HOSTS` and from an address in
     `TRUSTED_PROXIES` (default: loopback and private networks, which covers a proxy on the same host; set it to your
     proxy's address or CIDR if it sits elsewhere).
   - Allow request bodies of at least **5 MB** (encrypted parts are about 4.2 MB).
   - **Don't add or change security headers.** The app sets its own strict Content-Security-Policy, HSTS and others.
   - Plain HTTP between proxy and app is fine, as long as they are on the same host.

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name photos.example.com;
  # ssl_certificate ...;
  client_max_body_size 8m;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_request_buffering off;
  }
}
```

### C. Caddy with automatic HTTPS

1. Point a DNS name at the machine and make ports 80 and 443 reachable.
2. `.env`: `COMPOSE_FILE=compose.yaml:compose.caddy.yaml`, `SITE_ADDRESS=photos.example.com`.
3. `docker compose up -d --build`. Caddy gets and renews the certificate by itself.

This puts the login page on the public internet. The app is invite-only (no public sign-up), rate-limits
logins, and stores nothing readable, but keep it updated.

## First start: create the admin

1. Start the stack and read the one-time setup token from the log:
   `docker compose logs app | grep "FIRST-TIME SETUP"`
2. Open the site. It shows **Set up Cipherfilm**: paste the token, enter your e-mail and a password.
   The e-mail is only a login name; **Cipherfilm never sends e-mail.**
3. **Save the recovery key** shown next (copy, download or print) and tick the box.
   The setup screen disappears for good once the first account exists.

## Inviting people

Open **Admin → Invite someone**, enter their e-mail (and, if you like, a storage limit) and copy the link. Send the link yourself
(message, in person). It works once and expires after 7 days. They choose a password, and their browser
creates their keys and shows them their own recovery key. You can disable, enable or delete accounts there,
see how much storage each person uses and change their limit (default 20 GB; the admin has no limit).

## Backup and restore

What is backed up: the database (accounts, encrypted keys, encrypted metadata) and the encrypted files. All
of it is ciphertext. **It is not a backup of anyone's recovery key or password.**

```bash
scripts/backup.sh /path/to/backups     # writes cipherfilm-YYYYMMDD-HHMMSS.tar, safe while the app runs
```

The script first takes a consistent snapshot of the database, *then* copies the files, so everything the
snapshot refers to is in the backup (an upload that finished in between is simply not in it). Run it from
cron, e.g. `15 3 * * * cd /opt/cipherfilm && scripts/backup.sh /mnt/backups`, and keep copies on another
machine. If you changed `DATA_VOLUME`, export it for the scripts.

**Restore** (this replaces everything in the volume):

```bash
scripts/restore.sh /path/to/cipherfilm-20261102-035500.tar --yes
```

It first checks the archive (required files present, no symlinks or paths that escape the data directory), then stops the app (and refuses to go on if it keeps running), moves the current data aside to `.previous/` in the volume (a rename, no extra space: if it was the wrong archive, nothing is lost), puts the backup in place, ends every session (an older backup revives revoked ones), gives items in the restored trash a fresh 30 days, starts the app and prints a health report (database integrity, number
of users and items, items with missing files). Also run `docker compose exec app /app check` any time.

**Off-site, every night:** with the Tailscale option, `compose.kopia.yaml` adds Kopia, which saves the same data to
Nextcloud (WebDAV), S3, SFTP and others, with its UI only in your tailnet: [docs/BACKUP-KOPIA.md](docs/BACKUP-KOPIA.md).

**Test your backups.** A backup you have never restored is a hope. On a spare machine, restore the file and
sign in as a user.

## Updating

```bash
scripts/backup.sh /path/to/backups
git pull
docker compose up -d --build
```

Database changes are applied automatically at start. Browsers pick up the new web app on the next load.

Released versions are published as a multi-architecture image (amd64 and arm64) on GitHub's container
registry, built by a GitHub Action from a version tag. Instead of building yourself, set
`CIPHERFILM_IMAGE=ghcr.io/basmatiactivist/cipherfilm:2` in `.env` and run `docker compose pull && docker compose up -d`.
`:1` follows every 1.x release, `:1.0.0` pins one exact version, `:latest` is the newest stable release.
Release notes are in [CHANGELOG.md](CHANGELOG.md) and on the Releases page; read them before a major upgrade.
Check the running version in the admin area under Server, or with `docker compose exec app /app version`.
How releases are made: [docs/RELEASING.md](docs/RELEASING.md).

### Server commands

Accounts can also be managed from the server, like Immich's server commands: `docker compose exec app /app help`
lists them (list users, make someone an administrator, lock or delete an account, set a storage limit, sign out a
lost device, make an invite link, status). A password can't be reset from the server, by design. All commands and why:
[docs/SERVER-COMMANDS.md](docs/SERVER-COMMANDS.md).

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `COMPOSE_FILE` | `.env` | | which deployment option |
| `TRUST_PROXY` | env / `.env` | `0`; `1` for options B and C | trust the last `X-Forwarded-For` entry from exactly one proxy; needs `PUBLIC_HOSTS` |
| `TRUSTED_PROXIES` | `.env` | empty (loopback and private networks) | addresses or CIDRs whose `X-Forwarded-For` is believed, comma-separated |
| `PUBLIC_HOSTS` | `.env` | empty (any); required with `TRUST_PROXY=1` (option B; set from `SITE_ADDRESS` in C) | names the app answers for, e.g. `photos.example.com` or `photos.<tailnet>.ts.net`; others get 421 |
| `DATA_VOLUME` | `.env` | `cipherfilm_data` | Docker volume for database and files |
| `LISTEN_ADDR`, `DATA_DIR` | app env | `:8080`, `/data` | inside the container |

Built-in limits: 20 GB per invited user (changeable; thumbnails and previews count too), 50 unfinished uploads per user, 8 GB per file, sessions end 30 days after their last use or a year after signing in, trash empties after 30 days, 10 failed sign-ins per account and source address and 30 per source address overall, per 15 minutes. There is no ceiling across all sources, on purpose: it would let a stranger lock you out. Browsers that signed in before have their own limit of 20 per account.

## Troubleshooting

- **"Open Cipherfilm over https"**: you opened an http address. Use the https one.
- **Video won't stream or downloads are limited in size**: the Service Worker didn't register. This needs a trusted
  HTTPS certificate (not a click-through warning) and isn't available in some private-browsing modes. The app
  then falls back to preparing files in memory, up to 512 MB.
- **Uploads fail behind a proxy**: raise its body-size limit (≥ 5 MB) and timeouts.
- **Everyone gets "too many attempts"**: `TRUST_PROXY` is wrong, so all visitors share one address.
- **iPhone videos don't play in some browsers**: they are often HEVC. Use "Download original" or Safari.

## Development

```bash
make up          # build and start at https://cipherfilm.orb.local (OrbStack)
make test        # Go and web unit tests (in Docker)
make e2e         # throwaway stack, Playwright browser tests, then a check that no plaintext reached the server
make reset       # wipe the dev stack
make prod-config # validate all production compose combinations
make multiarch   # prove the image builds for amd64 and arm64
```

Layout: `server/` (Go, SQLite, no CGO), `web/` (Preact, TypeScript, libsodium), `mobile/` (Android), `mac/` (Swift,
see [mac/README.md](mac/README.md)), `e2e/` (Playwright),
`deploy/` (Tailscale and Caddy config), `scripts/` (backup, restore), `docs/` (crypto, threat model).
The design is explained in [PLAN.md](PLAN.md).

## Known limitations

No 2FA. No sharing between users. No server-side thumbnails or transcoding (the server can't see content).
The server learns who has accounts, how many items they have, their sizes and when they were uploaded.
Large downloads were tested only at small sizes. This code has not had an independent security review.

## Admin area

**Admin** (visible to administrators only) shows who is on the server and how much they use, last sign-in per person, open invites (revocable), a default storage limit for new people, per-person limits, role changes (make someone an administrator or a regular user), server status (disk, data size, signed-in devices, last backup) and a log of recent admin actions. None of it exposes photos, album names or file names.

## Uploading a large folder from a Mac

For a big library the browser is not ideal: the tab has to stay open, and one dropped connection costs time.
`cipherfilm-upload` (in `tools/upload`) does the same encrypted upload from the command line. Every release has
`cipherfilm-upload-darwin-arm64` (Apple silicon) and `-amd64` (Intel); or run `make upload-tool`.

```bash
./cipherfilm-upload-darwin-arm64 --server https://photos.example.com --email you@example.org ~/Pictures/Export
```

- It asks for your password (nothing is shown), or reads it with `--password-file`. The password never goes on the
  command line, and only ciphertext leaves the Mac, in exactly the web app's format.
- It takes every JPEG, PNG, WebP, HEIC, GIF, DNG, MP4, MOV and M4V in the folder and its subfolders, and skips hidden
  files. Capture date, size, camera and position come from the files; thumbnails are made with macOS's own `sips` and
  QuickLook (or `ffmpeg`, if installed).
- Files already in your library (same name, size and capture time) are skipped; `--allow-duplicates` uploads them anyway.
- Three files and three parts per file go up at the same time (`--parallel`, `--segments`), each on its own
  connection. Failed requests are retried for several minutes, and an expired session is renewed on its own.
- Stopped, or the Mac went to sleep? Run the same command again: finished files are skipped and half-finished ones
  continue from the last part the server has. Its notes live in `~/Library/Application Support/cipherfilm-upload`
  and hold item keys only in encrypted form.
- A full storage limit stops the run with a message; files larger than 8 GB are skipped.

`make upload-e2e` tests it end to end on a Mac against a throwaway local server.

## Getting your photos back without the app

If the server or its container is gone, your data is still enough. `tools/decrypt` is a separate, self-contained
program (no network, no Docker, no Cipherfilm code) that restores the original files straight from the data folder.

Every release on the Releases page has ready-made binaries for macOS (Apple silicon and Intel), Linux (amd64
and arm64) and Windows, with a `SHA256SUMS` file. Or build them yourself:

```bash
make decrypt-tool          # builds dist/decrypt/cipherfilm-decrypt-darwin-arm64 (and -amd64, linux)
```

**Do this now and keep the binary next to your data and your backups.** You can build it again from `tools/decrypt` at any time with Go 1.26 or newer.

```bash
./cipherfilm-decrypt-darwin-arm64 --list DATA_FOLDER                                  # accounts in it, needs no password
./cipherfilm-decrypt-darwin-arm64 --email you@example.org --out ~/Pictures/restored DATA_FOLDER
```

`DATA_FOLDER` can be any of these; **no backup step is needed**:
- the live data folder of an instance (it holds `app.db`, `app.db-wal` and `blobs/`), for example `deploy/mac-local` setups keep it in `data/`;
- a copy of the whole Docker volume;
- an extracted backup (`tar -xf cipherfilm-....tar -C restore-me`, then `restore-me`), which holds `backup/app.db` and `blobs/`.

If a folder holds both a live database and an older snapshot in `backup/`, the newer one is used.

- It asks for your password (nothing is shown). Lost it? Add `--recovery` and type your 24-word recovery key.
- Originals come back unchanged under `Library/<year>/<year-month>/`, deleted items under `Trash/`, and your albums as
  folders of links under `Albums/`. File dates are set to the capture date.
- `--verify` checks that everything decrypts without writing any files. Damaged or altered files are reported by name,
  and everything else is still restored.
- It reads the data but never changes it. The database is copied to a temporary folder first. If the app is running and
  someone uploads at that moment, the very last upload can be missing; stop the app first for a complete picture.
- A hostile folder cannot make it write outside `--out`, but a tampered database can still hide or move items: it
  decrypts what the keys authenticate and nothing else.

## Run it on your Mac (OrbStack)

`deploy/mac-local/` is a ready-made setup for one instance on your own Mac at `https://<name>.orb.local`, reachable only
from that Mac: a `compose.yaml` (hardened, data in a `data/` folder next to it), a `fotocrypt.sh` helper
(`start`, `stop`, `status`, `logs`, `backup`, `restore`, `update`, `list`, `export`) and a German `LIES-MICH.md`.
Create a folder, copy the three files in, build the image once (`docker build -t fotocrypt:local .` in the project) and
run `./fotocrypt.sh start`. The first-account token is printed in the container log (`./fotocrypt.sh token`).
Moving to a server later is a backup, a copy and `scripts/restore.sh`: step by step in [docs/MIGRATION.md](docs/MIGRATION.md).

## Status and honest limits

Cipherfilm is young software written with the help of AI agents. It has not been reviewed by an independent human security
reviewer. Four rounds of AI-agent source audits found and fixed a number of issues; their results are summarised in
[SECURITY.md](SECURITY.md). Do not rely on it for anything where losing the data or leaking it would be catastrophic, and keep
your own backups. Not tested: large libraries (tens of thousands of photos), the Caddy overlay on a real
server, and iOS Safari uploads at scale.

## Contributing and security reports

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service, you must offer its source to the users of that service.
