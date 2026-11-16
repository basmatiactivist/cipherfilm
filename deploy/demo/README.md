# Public demo server

A Cipherfilm server with one login published on a website, so anyone can try the apps. Everything is end-to-end
encrypted, so the operator could never see what strangers store. That is why the demo account is read-only
(`DEMO_ACCOUNTS`, [docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md#settings)): visitors can sign in, browse, open
originals and videos and search, but uploads, edits, albums and account changes get a 403 ("This is the public demo:
changes are turned off."). The apps say "Public demo · read-only · resets every hour" and hide what would fail. Other
accounts on the same server (app-store reviewers) work as usual. The storage and backup overview never
lists the demo account's devices to an administrator, and each visitor sees only their own (`server/storage.go`).

### Reviewer accounts

The project's demo has two reviewer accounts besides `demo@`: `reviewer@`, an ordinary user, and `reviewer2@`, an
administrator, so a reviewer can see the admin area. That is safe for the public login: the server refuses every
administrative change to a `DEMO_ACCOUNTS` account (deleting, disabling, making it an administrator, its storage
limit, turning off its two-step sign-in; `server/handlers_admin.go` `adminGuard`), and a `DEMO_ACCOUNTS` account can
never use the admin area itself. Only the server commands (`/app …`) can still change it. Give reviewer accounts no
explicit search and a small storage limit (and keep the server's default limit small: `revoke-admin` gives it).

An administrator login is a full administrator, though: there is no read-only kind. Whoever holds `reviewer2@`'s
password can see every other account's e-mail address, last sign-in and the activity log, make other accounts
administrators or regular users, disable or delete them, and invite new people with any storage limit. So:

- **Keep no account of your own on the demo.** `reviewer2@` is its only administrator; you run the server with the
  server commands on the host (`docker compose exec app /app …`, [docs/SERVER-COMMANDS.md](../../docs/SERVER-COMMANDS.md)),
  which need no account. An admin account of yours next to `reviewer2@` could be demoted, locked or deleted by
  whoever has the reviewer's password.
- **Give `reviewer2@`'s password only where an administrator is really needed**, and to no one else; the store's
  App access form usually needs only `reviewer@`.
- **The daily reset puts the reviewer accounts back.** It restores the seed, which drops accounts and invites made
  since, but keeps the roles and states of the seed's accounts as they were (see below). List the reviewer accounts
  for `reset.sh` (`DEMO_ADMINS`, `DEMO_USERS`, in the reset unit below) and it makes them enabled administrators or
  enabled regular users again after each reset. Check `/app list-users` after a store review.

The demo account stores nothing, so all that visitors leave behind are their sign-ins: every hour a timer signs out
all of the demo account's devices (`/app sign-out DEMO_EMAIL`). Once a day (04:00 UTC) the whole server is put back to
a seed, `seed.tar` (a backup made with `scripts/backup.sh`), restored by `reset.sh`; that ends every session, the
reviewer's included, so it runs only daily. What happened to the accounts since the seed was made stays as it is: a
changed password, a disabled or deleted account and the activity log are taken over from the replaced data.

Limits, because the login is published (server/demo.go): per visitor's address, 10 requests a second on average
(300 at once), 30 sign-ins an hour and its own turns for the library lists; no search models through the server.
Other accounts on the server, such as an app-store reviewer's, are not limited this way. A flood from many addresses
can only be stopped in front of the server: put a CDN such as Cloudflare in front and let 80/443 in only from it.
On a host shared with a private instance, give the demo less CPU weight (`cpu_shares: 512` for its app) so the
private one stays responsive.

## 1. The server

A normal install from the Cipherfilm checkout ([docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md)), on a public
domain behind an HTTPS proxy. The administrator the setup creates is `reviewer2@`, not an account of your own
("Reviewer accounts" above); invite `reviewer@` with `/app invite`. Leave `DEMO_ACCOUNTS` empty for now.

## 2. The demo account

Make an invite on the server, then accept it from your computer with the web app's own crypto. The password comes from
an environment variable, never the command line; the recovery words are printed on stdout only:

```sh
docker compose exec app /app invite demo@example.org --url https://demo.example.org
cd web && npm ci
read -rs CF_DEMO_PASSWORD && export CF_DEMO_PASSWORD     # type the demo password, then Enter
(umask 077; npx tsx ../deploy/demo/create-account.mts 'https://demo.example.org/invite/…' demo@example.org > demo-recovery.txt)
```

Keep `demo-recovery.txt` private. (Against a server with a locally issued certificate, put
`NODE_EXTRA_CA_CERTS=/path/to/root.crt` in front.)

## 3. Photos

Upload only photos you may publish, with the uploader ([docs/TOOLS.md](../../docs/TOOLS.md)), the password in a file
that only you can read:

```sh
printf %s "$CF_DEMO_PASSWORD" > pw && chmod 600 pw
./cipherfilm-upload --server https://demo.example.org --email demo@example.org --password-file pw ~/DemoPhotos
rm pw
```

Albums, favorites and search (sign in on the Android or Mac app and turn search on) can be set up now too: they go
into the seed.

## 4. The seed, then DEMO_ACCOUNTS

```sh
scripts/backup.sh deploy/demo && mv deploy/demo/cipherfilm-*.tar deploy/demo/seed.tar
echo DEMO_ACCOUNTS=demo@example.org >> .env
echo 'DEMO_LOGIN=demo@example.org the-public-password' >> .env   # the sign-in page offers it ("Open the demo")
docker compose up -d
```

Set `DEMO_ACCOUNTS` only after the photos are uploaded and the seed is made: from then on the account can't add
anything. Never list the administrator or an account with real photos.

To change the seed later, do it on a copy, never on the public server: there, without `DEMO_ACCOUNTS`, everyone who
knows the published password could change the library, and whatever they leave would go into the new seed. On your
own computer, in a Cipherfilm checkout with a local install (`DEMO_ACCOUNTS` and `DEMO_LOGIN` empty, not reachable
from the internet), restore the seed with `scripts/restore.sh seed.tar --yes`, change the library in the local web
app, make the new seed with `scripts/backup.sh deploy/demo`, copy it to the server as `deploy/demo/seed.tar` and run
`deploy/demo/reset.sh` there. Only the library comes in this way: the reset keeps the server's accounts as they are, so
a password changed or an account added on the copy doesn't reach the server (an added account arrives disabled).

## 5. The resets

`/etc/systemd/system/cipherfilm-demo-reset.service` (the path is your checkout):

```ini
[Unit]
Description=Reset the Cipherfilm demo to its seed
[Service]
Type=oneshot
# the reviewer accounts whose role and state each reset puts back ("Reviewer accounts" above)
Environment="DEMO_ADMINS=reviewer2@example.org" "DEMO_USERS=reviewer@example.org"
ExecStart=/opt/cipherfilm/deploy/demo/reset.sh
```

`/etc/systemd/system/cipherfilm-demo-reset.timer`:

```ini
[Unit]
Description=Reset the Cipherfilm demo every day
[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

```sh
systemctl daemon-reload && systemctl enable --now cipherfilm-demo-reset.timer
systemctl start cipherfilm-demo-reset.service && journalctl -u cipherfilm-demo-reset -n 20   # try it once
```

Every hour, sign out the demo visitors: `/etc/systemd/system/cipherfilm-demo-signout.service` runs
`/bin/sh -c 'cd /opt/cipherfilm && docker compose exec -T app /app sign-out demo@example.org'` (the same checkout as
the reset), and check once that it works (`systemctl start cipherfilm-demo-signout.service`, then `journalctl -u
cipherfilm-demo-signout -n 5`), and its timer has
`OnCalendar=hourly`.

Then publish the e-mail and the password, never the recovery words.
