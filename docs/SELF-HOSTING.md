# Self-hosting Cipherfilm

Everything about running the server: how to deploy it, the first start, inviting people, backups, updates and
settings. Download links for every app are in [INSTALL.md](INSTALL.md).

## Requirements

- Docker with the Compose plugin (`docker compose`) on a Linux or macOS machine (amd64 or arm64).
- **HTTPS.** The browser's encryption features, the Service Worker (video, big downloads) and the secure
  session cookie need it. Cipherfilm doesn't provide HTTPS itself; one of the three options below does.

## Choose how to deploy

Pick exactly one. They share one base file, [compose.yaml](../compose.yaml), which runs only the app, publishes
**no ports**, runs read-only as a non-root user, and stores data in the Docker volume `cipherfilm_data`.

| Option | Who it is for | HTTPS from | Open ports on the host |
|---|---|---|---|
| **A. Tailscale** | Private use; reachable only by devices on your tailnet | Tailscale Serve | none |
| **B. Your own reverse proxy** | You already run nginx, Caddy, Traefik, a Cloudflare Tunnel, … | your proxy | `127.0.0.1:8080` only |
| **C. Caddy (bundled)** | A public site on your own domain | Let's Encrypt, automatic | 80 and 443 |

Copy [.env.example](../.env.example) to `.env`, choose the option with `COMPOSE_FILE`, fill in its settings and
start:

```bash
cp .env.example .env      # edit it
docker compose up -d --build
docker compose logs app | grep "FIRST-TIME SETUP"
```

### A. Tailscale

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns) turn on **HTTPS certificates**
   (and MagicDNS); Serve needs them.
2. Create an **auth key** (Settings → Keys). A one-off key is enough: it is only used the first time
   (`TS_AUTH_ONCE=true`, and the node's state is kept in the `cipherfilm_tsstate` volume).
3. In `.env`: `COMPOSE_FILE=compose.yaml:compose.tailscale.yaml`, `TS_AUTHKEY=…`, `TS_HOSTNAME=photos`, and
   `PUBLIC_HOSTS=photos.<your-tailnet>.ts.net` (recommended: the app then refuses requests for any other name).
4. `docker compose up -d --build`. The site is at `https://photos.<your-tailnet>.ts.net`.

The app shares the Tailscale container's network, so nothing is published on the host.
[deploy/tailscale/serve.json](../deploy/tailscale/serve.json) makes Tailscale Serve forward HTTPS to the app and
sets `AllowFunnel` to `false`, so it is never exposed to the public internet.

A name of your own (`photos.example.com`) works too, still only inside the tailnet: [docs/OWN-DOMAIN.md](OWN-DOMAIN.md).

Tested on a Debian 13 VPS with the released image. After the first start,
`docker compose exec tailscale tailscale serve status` shows `https://<name>.<tailnet>.ts.net (tailnet only)`; the
first certificate takes a few seconds. Then, in the admin console, turn off **key expiry** for the machine (otherwise
it drops off the tailnet after about 180 days) and delete the used auth key. The host needs no open ports except SSH;
see [docs/SERVER-HARDENING.md](SERVER-HARDENING.md).

### B. Your own reverse proxy

1. `.env`: `COMPOSE_FILE=compose.yaml:compose.proxy.yaml`, `PUBLIC_HOSTS=photos.example.com` (the name your proxy
   serves; required) and optionally `APP_PORT=8080`.
2. Point your proxy at `http://127.0.0.1:8080`. Requirements:
   - **Forward `Host` and add `X-Forwarded-For`.** Login rate limits use the client address; with exactly one
     proxy in front, leave `TRUST_PROXY=1`. Behind a Cloudflare Tunnel or several proxies set
     `TRUST_PROXY=0`. Then all clients share one address, so a stranger's failed logins can block *new* browsers
     for up to 15 minutes; browsers that signed in before are not affected (device cookie).
     `X-Forwarded-For` is only believed for requests to a name in `PUBLIC_HOSTS` and from an address in
     `TRUSTED_PROXIES` (default: loopback and private networks, which covers a proxy on the same host; set it to your
     proxy's address or CIDR if it sits elsewhere).
   - Allow request bodies of at least **5 MB** (encrypted parts are about 4.2 MB).
   - **Don't add or change security headers.** The app sets its own strict Content-Security-Policy, HSTS and others.
   - Plain HTTP between proxy and app is fine if both are on the same host.

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
3. `docker compose up -d --build`. Caddy gets and renews the certificate.

This puts the login page on the public internet. The app is invite-only (no public sign-up), rate-limits
logins, and stores nothing readable, but keep it updated.

## First start: create the admin

1. Start the stack and read the one-time setup token from the log:
   `docker compose logs app | grep "FIRST-TIME SETUP"`
2. Open the site. It shows **Set up Cipherfilm**: paste the token, enter your e-mail and a password.
   The e-mail is only a login name; **Cipherfilm never sends e-mail.**
3. **Save the recovery key** shown next (copy, download or print) and tick the box.
   The setup screen disappears once the first account exists.

## Inviting people

Open **Admin → Invite someone**, enter their e-mail (and optionally a storage limit) and copy the link. Send it
yourself (message, in person). It works once and expires after 7 days. They choose a password; their browser creates
their keys and shows their recovery key. The admin area also lets you disable, enable or delete accounts, see each
person's storage and change their limit (default 20 GB; the admin has no limit).

## Backup and restore

What is backed up: the database (accounts, encrypted keys, encrypted metadata) and the encrypted files. All
of it is ciphertext. **It is not a backup of anyone's recovery key or password.**

```bash
scripts/backup.sh /path/to/backups     # writes cipherfilm-YYYYMMDD-HHMMSS.tar, safe while the app runs
```

The script first takes a consistent snapshot of the database, *then* copies the files, so everything the
snapshot refers to is in the backup (an upload that finished in between is not in it). Run it from
cron, e.g. `15 3 * * * cd /opt/cipherfilm && scripts/backup.sh /mnt/backups`, and keep copies on another
machine. If you changed `DATA_VOLUME`, export it for the scripts.

**Restore** (this replaces everything in the volume):

```bash
scripts/restore.sh /path/to/cipherfilm-20261102-035500.tar --yes
```

It checks the archive (required files present, no symlinks or paths outside the data directory) and stops the app
(refusing to go on if it keeps running). It moves the current data aside to `.previous/` in the volume (a rename, no
extra space; nothing is lost if it was the wrong archive), puts the backup in place, ends every session (an older
backup would revive revoked ones) and gives items in the restored trash a fresh 30 days. Then it starts the app and
prints a health report (database integrity, number of users and items, items with missing files). You can run
`docker compose exec app /app check` any time.

**Off-site, every night:** with the Tailscale option, `compose.kopia.yaml` adds Kopia, which saves the same data to
Nextcloud (WebDAV), S3, SFTP and others, with its UI only in your tailnet: [docs/BACKUP-KOPIA.md](BACKUP-KOPIA.md).

**Test your backups:** restore one on a spare machine and sign in as a user.

## Updating

```bash
scripts/backup.sh /path/to/backups
git pull
docker compose up -d --build
```

Database changes are applied automatically at start. Browsers pick up the new web app on the next load.

Releases are published as a multi-architecture image (amd64 and arm64) on GitHub's container registry, built
from a version tag. Instead of building yourself, set
`CIPHERFILM_IMAGE=ghcr.io/basmatiactivist/cipherfilm:2` in `.env` and run `docker compose pull && docker compose up -d`.
`:2` follows every 2.x release, `:2.1.3` pins one exact version, `:latest` is the newest stable release.
Release notes are in [CHANGELOG.md](../CHANGELOG.md) and on the Releases page; read them before a major upgrade.
Check the running version in the admin area under Server, or with `docker compose exec app /app version`.
How releases are made: [docs/RELEASING.md](RELEASING.md).

### Server commands

Accounts can also be managed on the server: `docker compose exec app /app help` lists the commands (list users, make someone an administrator, lock or delete an account, set a storage limit, sign out a
lost device, make an invite link, status). A password can't be reset from the server, by design. All commands and why:
[docs/SERVER-COMMANDS.md](SERVER-COMMANDS.md).

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `COMPOSE_FILE` | `.env` | | which deployment option |
| `TRUST_PROXY` | env / `.env` | `0`; `1` for options B and C | trust the last `X-Forwarded-For` entry from exactly one proxy; needs `PUBLIC_HOSTS` |
| `TRUSTED_PROXIES` | `.env` | empty (loopback and private networks) | addresses or CIDRs whose `X-Forwarded-For` is believed, comma-separated |
| `PUBLIC_HOSTS` | `.env` | empty (any); required with `TRUST_PROXY=1` (option B; set from `SITE_ADDRESS` in C) | names the app answers for, e.g. `photos.example.com` or `photos.<tailnet>.ts.net`; others get 421 |
| `DEMO_ACCOUNTS` | `.env` | empty | e-mail addresses of public demo accounts, comma-separated: they can sign in, look and search, but not upload, edit, delete or change the account (403); see [deploy/demo](../deploy/demo/README.md) |
| `DATA_VOLUME` | `.env` | `cipherfilm_data` | Docker volume for database and files |
| `LISTEN_ADDR`, `DATA_DIR` | app env | `:8080`, `/data` | inside the container |

`DEMO_ACCOUNTS` is only for a server whose login you publish on purpose, such as a demo that is reset from a seed. Never
list an account with real photos or an administrator: anyone with the password can see everything in it.

Built-in limits: 20 GB per invited user (changeable; thumbnails and previews count too), 50 unfinished uploads per user, 8 GB per file, sessions end 30 days after their last use or a year after signing in, trash empties after 30 days, 10 failed sign-ins per account and source address and 30 per source address overall, per 15 minutes. There is no ceiling across all sources, on purpose: it would let a stranger lock you out. Browsers that signed in before have their own limit of 20 per account.

## Troubleshooting

- **"Open Cipherfilm over https"**: you opened an http address. Use the https one.
- **Video won't stream or downloads are limited in size**: the Service Worker didn't register. This needs a trusted
  HTTPS certificate (not a click-through warning) and isn't available in some private-browsing modes. The app
  then falls back to preparing files in memory, up to 512 MB.
- **Uploads fail behind a proxy**: raise its body-size limit (≥ 5 MB) and timeouts.
- **Everyone gets "too many attempts"**: `TRUST_PROXY` is wrong, so all visitors share one address.
- **iPhone videos don't play in some browsers**: they are often HEVC. Use "Download original" or Safari.

## Deleting your account

Everyone can delete their own account: **Account › Delete account** in the web app, the Android app and the Mac app
(Settings › General). It asks for the password, then deletes the account with all its photos, videos, albums, people
and search data from the server at once (`DELETE /api/me` with the current sign-in proof, as for a password change),
signs out every device, and each device deletes what it keeps. The only active administrator has to make someone
else an administrator first. Copies of the whole server an administrator made (`scripts/backup.sh`, Kopia) follow
their own retention. An administrator can also delete an account (Admin › Users, or `delete-user EMAIL --yes`,
[docs/SERVER-COMMANDS.md](SERVER-COMMANDS.md)). The Cipherfilm developer holds no account data: accounts exist
only on the server your administrator runs.

## Admin area

**Admin** (visible to administrators only) shows who is on the server and how much they use, last sign-in per person, open invites (revocable), a default storage limit for new people, per-person limits, role changes (make someone an administrator or a regular user), server status (disk, data size, signed-in devices, last backup) and a log of recent admin actions. None of it exposes photos, album names or file names.
