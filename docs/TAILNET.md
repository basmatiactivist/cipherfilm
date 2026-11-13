# Private server in your tailnet

A Cipherfilm server that is reachable **only from your own devices**, through [Tailscale](https://tailscale.com), with
no open web ports. This is the setup the project's own server runs; the files are in [deploy/tailnet](../deploy/tailnet).
The plain [compose.yaml](../compose.yaml) stays the base; each overlay adds one piece:

| Overlay | Adds | Needs in `.env` |
|---|---|---|
| `compose.tailscale.yaml` | Tailscale; HTTPS on `https://<TS_HOSTNAME>.<tailnet>.ts.net` via Tailscale Serve | `TS_AUTHKEY`, `TS_HOSTNAME`, `PUBLIC_HOSTS` |
| `compose.kopia.yaml` | Kopia for off-site backups, UI on `:8443` in the tailnet | `KOPIA_SERVER_PASSWORD` |
| `compose.domain.yaml` | your own name (e.g. `photos.example.com`) inside the tailnet, certificate via Cloudflare DNS | `DOMAIN`, `TS_DOMAIN`, `CF_API_TOKEN` |
| `compose.portainer.yaml` | optional Portainer UI on `:9443` in the tailnet | `PORTAINER_ADMIN_PASSWORD_FILE` |

Pick them with `COMPOSE_FILE` in `.env`, base first, in this order:

```bash
COMPOSE_FILE=compose.yaml:deploy/tailnet/compose.tailscale.yaml:deploy/tailnet/compose.kopia.yaml:deploy/tailnet/compose.domain.yaml
```

## What each container may do

Every container runs with `no-new-privileges`, and apart from Tailscale and Portainer with no capabilities and a
read-only root file system, with memory and process limits.

- **app**: non-root (uid 65532), read-only, no capabilities, no host port (the overlay removes the base file's
  `127.0.0.1:8080`); it listens on `127.0.0.1:8080` inside Tailscale's network namespace, so only Tailscale Serve and
  Caddy reach it, not even other tailnet devices directly. Since every request then comes from `127.0.0.1`, the
  sign-in limits per source would be one bucket for everyone (one person's wrong passwords could block everyone's
  sign-in on a new device); with `TRUST_TAILSCALE_HEADERS=1` (set by this overlay) they are kept per tailnet user,
  by the `Tailscale-User-Login` header Tailscale Serve adds (Serve removes the header from what a client sends).
  Tagged devices get no such header and still share one bucket. The domain overlay turns it off again: there Serve
  passes the connection to Caddy unread and adds no header, and Caddy would forward one a client made up.
- **tailscale**: kernel networking (much faster than the userspace mode over long routes), which needs `/dev/net/tun`
  and `NET_ADMIN` + `NET_RAW` inside its own namespace. The one published host port is WireGuard's UDP `41641`, so
  devices connect directly instead of via relays. Funnel (public sharing) is off for every port.
- **caddy** (domain overlay): non-root (uid 10001), read-only, no capabilities; it listens on `127.0.0.1:4443` and gets
  the certificate by a DNS check, so nothing is opened to the internet. Tailscale lets this uid fetch the tailnet
  name's certificate over the socket (`TS_PERMIT_CERT_UID`) and nothing else. Use a Cloudflare token limited to
  *Zone › DNS › Edit* for that one zone.
- **kopia**: runs as the app's user, sees the data read-only, UI behind its own login on `127.0.0.1:51515`, HTTPS from
  Tailscale Serve on `:8443`.
- **portainer** (optional): has the Docker socket, so **whoever signs in to Portainer is root on the host**. Its admin
  account exists from the first start (below), so no one else can claim a fresh Portainer; turn on its two-factor
  login, and limit `:9443` to your own devices (access rules below). Leave the overlay out if
  `docker compose exec app cipherfilm …` over SSH is enough.

**Who may reach what.** Everything runs on one tailnet node, so by default every device that may reach the photos
(`:443`) may also reach Kopia's UI (`:8443`) and Portainer (`:9443`). Each has its own login, but Kopia's UI can read
and restore the backed-up (encrypted) files and Portainer is root on the host: only you should reach them. With
Tailscale's default policy (everyone in the tailnet reaches everything) this matters as soon as you share the server
with others. Tag the server (`tag:photos`, set with `--advertise-tags` or in the admin console) and replace the
allow-all rule in the access controls (Tailscale admin console › Access controls) with rules like these, `you@example.com`
being your own login:

```json
{
  "tagOwners": { "tag:photos": ["autogroup:admin"] },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:photos"], "ip": ["tcp:443"] },
    { "src": ["you@example.com"], "dst": ["tag:photos"], "ip": ["tcp:443", "tcp:8443", "tcp:9443"] }
  ]
}
```

Keep the rules your other devices need (your other grants) and check the result with the *Preview rules* tab: a
family member's phone should show only `tag:photos:443`. If you want Kopia's UI apart from the photos altogether, run
a second, small Tailscale container for it under its own node name and give only yourself access to that node; the
overlay keeps it on the same node for simplicity.

## Setup

1. Tailscale admin console: turn on MagicDNS and HTTPS certificates, create an auth key (Settings › Keys), and turn
   off key expiry for the server's machine afterwards.
2. On the server, copy `compose.yaml` and `deploy/tailnet/` (for example with `git archive`; on macOS set
   `COPYFILE_DISABLE=1` when using tar, or `._` files end up in the config folders) and write `.env`:

   ```bash
   COMPOSE_FILE=compose.yaml:deploy/tailnet/compose.tailscale.yaml
   TS_AUTHKEY=tskey-auth-...
   TS_HOSTNAME=photos
   PUBLIC_HOSTS=photos.your-tailnet.ts.net
   ```

3. `docker compose up -d`, then create the admin as in [SELF-HOSTING.md](SELF-HOSTING.md#first-start-create-the-admin).

**Own name.** Point an A record for `photos.example.com` at the server's tailnet address (100.x.y.z, DNS only, not
proxied), add the domain overlay and `DOMAIN`, `TS_DOMAIN`, `CF_API_TOKEN`, and add the name to `PUBLIC_HOSTS`
(comma-separated). The name resolves for everyone but only answers inside your tailnet.

**Portainer.** Write its admin password (at least 12 characters) into a file only you can read, and name it in
`.env`; Portainer creates the account `admin` with it at its first start, so there is no moment when a fresh
Portainer waits for whoever opens it first. Then sign in and turn on two-factor login. Keep the file (Compose needs
it to start the overlay); it is only read while Portainer has no admin, so changing the password later in Portainer
is fine, and a Portainer that already had an admin before this keeps it:

```bash
umask 077; printf '%s' 'a-long-random-password' > /opt/cipherfilm/portainer-admin-password
# .env
PORTAINER_ADMIN_PASSWORD_FILE=/opt/cipherfilm/portainer-admin-password
```

**Kopia.** Add the Kopia overlay and `KOPIA_SERVER_PASSWORD`, open `https://photos.your-tailnet.ts.net:8443`, connect
or create a repository (WebDAV, S3, SFTP, …) and set the policy for `/data` (ignore `/app.db*` and `/secret`, which
the snapshot below covers consistently). The nightly run, from the directory with `.env`:

```ini
# /etc/systemd/system/cipherfilm-snapshot.service
[Service]
Type=oneshot
WorkingDirectory=/opt/cipherfilm
ExecStart=/bin/sh deploy/tailnet/kopia-snapshot.sh
TimeoutStartSec=12h

# /etc/systemd/system/cipherfilm-snapshot.timer
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

It first makes a consistent database snapshot (`/app backup`), then Kopia saves the data; the result shows under
Admin › Server. Restoring: [MIGRATION.md](MIGRATION.md).

## Passkeys

Two-step sign-in with passkeys works here too. The browser and the Mac app use the server's name directly. The
Android app can't use Android's own passkey check for a server that isn't on the internet (Google fetches
`/.well-known/assetlinks.json` from the internet first), so for a `*.ts.net` name it opens the server's `/passkey` page
in the browser and takes the answer back; with your own name it tries Android's way once and, when Android refuses,
uses the browser from then on (docs/SELF-HOSTING.md "Passkeys"). Nothing to set up.

## Updating

`docker compose pull && docker compose up -d`. Copying new versions of the files in `deploy/tailnet/` over yours is
safe: nothing server-specific is in them, it all comes from `.env`.
