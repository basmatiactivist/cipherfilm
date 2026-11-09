# Public demo server

A Cipherfilm server with one login published on a website, so anyone can try the apps. Everything is end-to-end
encrypted, so the operator could never see what strangers store. That is why the demo account is read-only
(`DEMO_ACCOUNTS`, [docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md#settings)): visitors can sign in, browse, open
originals and videos and search, but uploads, edits, albums and account changes get a 403 ("This is the public demo:
changes are turned off."). The apps say "Public demo · read-only · resets every hour" and hide what would fail. Other
accounts on the same server (your admin, an app-store reviewer) work as usual.

The demo account stores nothing, so all that visitors leave behind are their sign-ins: every hour a timer signs out
all of the demo account's devices (`/app sign-out DEMO_EMAIL`). Once a day (04:00 UTC) the whole server is put back to
a seed, `seed.tar` (a backup made with `scripts/backup.sh`), restored by `reset.sh`; that ends every session, the
reviewer's included, so it runs only daily. What happened to the accounts since the seed was made stays as it is: a
changed password, a disabled or deleted account and the activity log are taken over from the replaced data.

## 1. The server

A normal install from the Cipherfilm checkout ([docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md)), on a public
domain behind an HTTPS proxy, with your own admin account. Leave `DEMO_ACCOUNTS` empty for now.

## 2. The demo account

Make an invite on the server, then accept it from your computer with the web app's own crypto. The password comes from
an environment variable, never the command line; the recovery words are printed on stdout only:

```sh
docker compose exec app /app invite demo@example.org --url https://demo.example.org
cd web && npm ci
read -rs CF_DEMO_PASSWORD && export CF_DEMO_PASSWORD     # type the demo password, then Enter
npx tsx ../deploy/demo/create-account.mts 'https://demo.example.org/invite/…' demo@example.org > demo-recovery.txt
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
anything. Never list your admin or an account with real photos.

To change the seed later, do it on a copy, never on the public server: there, without `DEMO_ACCOUNTS`, everyone who
knows the published password could change the library, and whatever they leave would go into the new seed. On your
own computer, in a Cipherfilm checkout with a local install (`DEMO_ACCOUNTS` and `DEMO_LOGIN` empty, not reachable
from the internet), restore the seed with `scripts/restore.sh seed.tar --yes`, change the library in the local web
app, make the new seed with `scripts/backup.sh deploy/demo`, copy it to the server as `deploy/demo/seed.tar` and run
`deploy/demo/reset.sh` there.

## 5. The resets

`/etc/systemd/system/cipherfilm-demo-reset.service` (the path is your checkout):

```ini
[Unit]
Description=Reset the Cipherfilm demo to its seed
[Service]
Type=oneshot
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
`/bin/sh -c 'cd /opt/cipherfilm-demo && docker compose exec -T app /app sign-out demo@example.org'`, and its timer has
`OnCalendar=hourly`.

Then publish the e-mail and the password, never the recovery words.
