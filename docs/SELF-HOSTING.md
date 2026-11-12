# Self-hosting Cipherfilm

Everything about running the server: how to deploy it, the first start, inviting people, backups, updates and
settings. Download links for every app are in [INSTALL.md](INSTALL.md).

## Requirements

- Docker with the Compose plugin (`docker compose`) on a Linux or macOS machine (amd64 or arm64).
- **HTTPS in front of it.** The browser's encryption features, the Service Worker (video, big downloads) and the
  secure session cookie need it. Cipherfilm doesn't provide HTTPS itself: use any reverse proxy you like (Caddy,
  nginx, Traefik, a Cloudflare Tunnel, Tailscale Serve, …).

## Deploy

[compose.yaml](../compose.yaml) runs only the app, from the released image, read-only as a non-root user, on
`127.0.0.1:8080`, with its data in the Docker volume `cipherfilm_data`.

```bash
mkdir cipherfilm && cd cipherfilm
curl -fsSLO https://raw.githubusercontent.com/basmatiactivist/cipherfilm/master/compose.yaml
echo "PUBLIC_HOSTS=photos.example.com" > .env      # the name your proxy serves; more settings: .env.example
docker compose up -d
docker compose logs app | grep "FIRST-TIME SETUP"
```

Then point your proxy at `http://127.0.0.1:8080`. It must:

- **Forward `Host` and add `X-Forwarded-For`.** Login rate limits use the client address. With exactly one proxy in
  front, keep `TRUST_PROXY=1`. Behind a Cloudflare Tunnel, Tailscale Serve or several proxies set `TRUST_PROXY=0`;
  then all clients share one address, so a stranger's failed logins can block *new* browsers for up to 15 minutes
  (browsers that signed in before are not affected). `X-Forwarded-For` is only believed for requests to a name in
  `PUBLIC_HOSTS` and from an address in `TRUSTED_PROXIES` (default: loopback and private networks, which covers a
  proxy on the same host).
- **Allow request bodies of at least 5 MB** (encrypted parts are about 4.2 MB).
- **Not add or change security headers.** The app sets its own strict Content-Security-Policy, HSTS and others.
- **Not buffer `/api/events`.** It is a long-lived stream (Server-Sent Events) that tells a person's other devices
  when something changed, so a photo uploaded on the phone shows in the browser within a second or two. The app sends
  `X-Accel-Buffering: no` and a heartbeat every 25 seconds; keep the proxy's read timeout above that. Caddy, Traefik,
  Tailscale Serve and Cloudflare Tunnels pass it on as it is. With nginx, add a location for it:

  ```nginx
  location /api/events {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_buffering off;
      proxy_read_timeout 1h;
  }
  ```

  A proxy that holds the stream back anyway only makes it slower: the apps then load the lists every 15 seconds.
  Serve HTTP/2 (`listen 443 ssl; http2 on;`; the others do by default): over HTTP/1.1 every open tab's stream takes
  one of the six connections a browser opens to a site.

Plain HTTP between proxy and app is fine on the same host. A proxy in a Docker container can't reach the host's
`127.0.0.1`. Either set `APP_BIND` to the Docker bridge's address (often `172.17.0.1`; `ip -4 addr show docker0`) and
point the proxy at `http://host.docker.internal:8080` (add `extra_hosts: ["host.docker.internal:host-gateway"]` to the
proxy's service), or attach the proxy to this stack's network and use `http://app:8080`, or run it with host networking.
Never bind to `0.0.0.0` on a machine reachable from the internet: that serves plain HTTP to everyone.

Example only, for Caddy (it gets the certificate itself):

```caddyfile
photos.example.com {
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-For {remote_host}   # exactly one entry, the real client
	}
}
```

For private use with no open ports, [Tailscale Serve](https://tailscale.com/kb/1312/serve) works too:
`tailscale serve --bg 8080` on the host, with `PUBLIC_HOSTS=<machine>.<tailnet>.ts.net` and `TRUST_PROXY=0`.
Add `TRUST_TAILSCALE_HEADERS=1` so sign-in limits are kept per tailnet user (the `Tailscale-User-Login` header Serve
adds) instead of one bucket for everyone, but only if nothing else that passes on client headers reaches the app on
loopback (no other proxy in front of it on the same host).
A complete private setup in Docker (Tailscale, your own name, Kopia backups, all without open web ports):
[TAILNET.md](TAILNET.md).

A public site puts the login page on the internet. The app is invite-only (no public sign-up), rate-limits logins and
stores nothing readable, but keep it updated. Hardening the host: [SERVER-HARDENING.md](SERVER-HARDENING.md).

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

Storage limits count bytes. Each photo also takes a few files on disk (a folder, its parts, a thumbnail and a preview),
and every item is charged at least about 4 KB per file for them. On a filesystem with a fixed number of files (ext4
makes one per 16 KB of disk by default, see `df -i`), keep the limits you hand out together well below a quarter of
the disk, so accounts can't run it out of files before it runs out of space.

## Backup and restore

Back up with any tool you like (restic, Borg, a volume snapshot, …). Before each run, write a consistent
database snapshot:

```bash
docker compose exec -T app /app backup     # writes backup/ in the data folder
```

Then back up the data volume (`cipherfilm_data`), at least `backup/` (snapshot and server secret) and `blobs/` (the
encrypted files). Restore from the snapshot, not the live `app.db`. It is all ciphertext, and **not a backup of
anyone's recovery key or password.** Your tool can show its result under Admin › Server with
`docker compose exec -T app /app backup-report ok` (or `failed snapshot`, `failed upload`).

No tool? `scripts/backup.sh /path/to/backups` does both steps into one `.tar`, safe while the app runs. Keep copies
on another machine. If you changed `DATA_VOLUME`, export it for the scripts.

**Restore** (replaces everything in the volume; the old data is kept in `.previous/`):

```bash
scripts/restore.sh /path/to/cipherfilm-20261102-035500.tar --yes
```

From your own tool's backup: `tar -cf restore.tar -C restored-folder backup blobs`, then restore that. The script ends
every session (an older backup would revive revoked ones) and prints a health report. What happened to the accounts
after the backup is taken over from the replaced data: devices signed out since, changed passwords and recovery keys,
two-step sign-in turned on or off, passkeys and new recovery codes (and the notices for the devices),
roles, storage limits (and the default one for new people), explicit search, and disabled or deleted accounts (those stay disabled; their e-mail addresses are printed). This applies only
when the replaced data is from the same server (the same `secret`).

If the last step (`after-restore`) fails, the script stops with the app stopped: the replaced data stays in
`.previous/`, and a `.restore-pending` file in the volume keeps the server from starting and `restore.sh` (and the
demo's `reset.sh`) from running again, which would drop `.previous/`. Fix the cause, then
`docker compose run --rm --no-deps -T app after-restore` (it removes the file) and `docker compose up -d app`.

**Test your restore** on a spare machine with `scripts/restore.sh`, and sign in as a user.

## Updating

```bash
docker compose exec -T app /app backup      # a database snapshot first, then let your backup tool run
docker compose pull && docker compose up -d
```

Database changes are applied automatically at start; browsers pick up the new web app on the next load. The image
`ghcr.io/basmatiactivist/cipherfilm:2` (amd64 and arm64) follows every 2.x release; a new major version (3.x) is
never pulled on its own, as it may need changes. `:X.Y.Z` pins one version, `:latest` follows everything. Release
notes: [CHANGELOG.md](../CHANGELOG.md) and the Releases page.

**From source** instead: `docker build -t cipherfilm:local .` in a checkout, then `CIPHERFILM_IMAGE=cipherfilm:local`
in `.env`.

Check the running version in the admin area under Server, or with `docker compose exec app /app version`.
How releases are made: [docs/RELEASING.md](RELEASING.md).

### Server commands

Accounts can also be managed on the server: `docker compose exec app cipherfilm help`, or `cipherfilm help` in the app container's console (Portainer: Console, `/bin/sh`), lists the commands (list users, make someone an administrator, lock or delete an account, set a storage limit, sign out a
lost device, make an invite link, status). A password can't be reset from the server, by design. All commands and why:
[docs/SERVER-COMMANDS.md](SERVER-COMMANDS.md).

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `PUBLIC_HOSTS` | `.env` | required | names your proxy serves, e.g. `photos.example.com`; others get 421 |
| `TRUST_PROXY` | `.env` | `1` | trust the last `X-Forwarded-For` entry from exactly one proxy; `0` for a chain, a Cloudflare Tunnel or Tailscale Serve |
| `TRUST_TAILSCALE_HEADERS` | `.env` | `0` | `1` behind Tailscale Serve with `TRUST_PROXY=0`: requests from loopback are limited per tailnet user (`Tailscale-User-Login`) instead of all as `127.0.0.1`. Only when Serve is the only thing reaching the app on loopback |
| `TRUSTED_PROXIES` | `.env` | empty (loopback and private networks) | addresses or CIDRs whose `X-Forwarded-For` is believed, comma-separated |
| `MAP_STYLE` | `.env` | empty (OpenFreeMap, VersaTiles as fallback) | the map tab's base map: `off`, or `LIGHT_STYLE_URL DARK_STYLE_URL` (your own MapLibre styles over https); photo locations never leave the devices, the tile server only sees which map areas are viewed ([docs/MAP.md](MAP.md); your own map server: [Your own map tiles](MAP.md#your-own-map-tiles)) |
| `DEMO_ACCOUNTS` | `.env` | empty | e-mail addresses of public demo accounts, comma-separated: they can sign in, look and search, but not upload, edit, delete or change the account (403); see [deploy/demo](../deploy/demo/README.md) |
| `DEMO_LOGIN` | `.env` | empty | `EMAIL PASSWORD` of one `DEMO_ACCOUNTS` login: the sign-in page shows it with an "Open the demo" button. The password is published, so only for a demo |
| `ANDROID_APP_CERTS` | `.env` | the official app's release key | SHA-256 fingerprints of the Android app signing certificates whose passkey requests are accepted (as `keytool -list -v` or Play Console › App integrity show them, with or without colons; comma-separated), and listed in `/.well-known/assetlinks.json`; `none` for no app. Add your own key for a self-built app, or the debug key of a test build |
| `ANDROID_APP_PACKAGES` | `.env` | `app.cipherfilm` | the Android packages listed in `/.well-known/assetlinks.json` (`app.cipherfilm.test` for a test build) |
| `APP_PORT` | `.env` | `8080` | port your proxy connects to |
| `APP_BIND` | `.env` | `127.0.0.1` | address the app listens on; the Docker bridge's address for a proxy in a container (see Deploy) |
| `DATA_VOLUME` | `.env` | `cipherfilm_data` | Docker volume for database and files |
| `LISTEN_ADDR`, `DATA_DIR` | app env | `:8080`, `/data` | inside the container |

`DEMO_ACCOUNTS` is only for a server whose login you publish on purpose, such as a demo that is reset from a seed. Never
list an account with real photos or an administrator: anyone with the password can see everything in it.

Built-in limits: 20 GB per invited user (changeable; thumbnails and previews count too), 50 unfinished uploads per user, 8 GB per file, sessions end 30 days after their last use or a year after signing in, trash empties after 30 days, 10 failed sign-ins per account and source address and 30 per source address overall, per 15 minutes. There is no ceiling across all sources, on purpose: it would let a stranger lock you out. Browsers that signed in before have their own limit of 20 per account. Live-update streams: 8 per session (browser tabs share one), 32 per account, 2000 in all.

## Passkeys

Two-step sign-in can use passkeys instead of the authenticator app's code (the password stays needed). They are made
for the name the server is reached by, so:

- Reach the server by its https name, the one in `PUBLIC_HOSTS`, never by an IP address; a passkey made under one name
  doesn't work under another. The proxy must pass the `Host` header on (it already must, for the CSRF check).
- The Android app (Android 14 and newer) asks Android, which checks `https://<name>/.well-known/assetlinks.json`
  through Google: the server serves it by itself, but the name and that file must be reachable from the internet. A
  tailnet-only server (Tailscale Serve, no Funnel) can't offer passkeys on Android; its people keep the code from the
  authenticator app, and passkeys still work in the browser and on the Mac. A self-built app needs its signing key
  in `ANDROID_APP_CERTS`.
- The Mac app opens the server's `/passkey` page in the default browser for each passkey step.

## Troubleshooting

- **"Open Cipherfilm over https"**: you opened an http address. Use the https one.
- **Video won't stream or downloads are limited in size**: the Service Worker didn't register. This needs a trusted
  HTTPS certificate (not a click-through warning) and isn't available in some private-browsing modes. The app
  then falls back to preparing files in memory, up to 512 MB.
- **Uploads fail behind a proxy**: raise its body-size limit (≥ 5 MB) and timeouts.
- **Everyone gets "too many attempts"**: `TRUST_PROXY` is wrong, so all visitors share one address.
- **Changes from another device show only after a while**: the proxy buffers `/api/events` (see Deploy).
- **iPhone videos don't play in some browsers**: they are often HEVC. Use "Download original" or Safari.

## Deleting your account

Everyone can delete their own account: **Account › Delete account** in the web app, the Android app and the Mac app
(Settings › General). It asks for the password, then deletes the account with all its photos, videos, albums, people
and search data from the server at once (`DELETE /api/me` with the current sign-in proof, as for a password change),
signs out every device, and each device deletes what it keeps. The only active administrator has to make someone
else an administrator first. Copies of the whole server an administrator made (`scripts/backup.sh`, their own backup tool) follow
their own retention. An administrator can also delete an account (Admin › Users, or `delete-user EMAIL --yes`,
[docs/SERVER-COMMANDS.md](SERVER-COMMANDS.md)). The Cipherfilm developer holds no account data: accounts exist
only on the server your administrator runs.

## Admin area

**Admin** (visible to administrators only) shows who is on the server and how much they use, last sign-in per person, open invites (revocable), a default storage limit for new people, per-person limits, role changes (make someone an administrator or a regular user), server status (disk, data size, signed-in devices, last backup) and a log of recent admin actions. None of it exposes photos, album names or file names.

The same is in the apps for administrators: on Android under **Account › Administration** (an invite link goes out
through the share sheet), on the Mac under **Settings › Administration**. They use the same API; the server checks
every request, so a regular account or a public demo login gets "not found" whatever an app shows. The Google Play
build leaves out the explicit-search permission (manage it on the web or the Mac).
