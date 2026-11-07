# Moving Cipherfilm to another machine

For example from the Mac setup in `deploy/mac-local/` to a VPS, or from one server to another. A move is a backup,
a copy and a restore. Nobody needs their password or recovery key for it, and nothing gets decrypted on the way:
the backup holds only ciphertext and the server's own secret.

`make migration-test` runs this whole procedure automatically (backup with `scripts/backup.sh`, restore into a new,
empty stack with `scripts/restore.sh`, sign in there, decrypt offline) and runs in CI on every push.

## What moves

| Path in the data folder | What it is | If it is lost |
|---|---|---|
| `app.db` | accounts, encrypted keys, encrypted metadata, albums | nothing can be read |
| `secret` | the server's secret for login hashes and cookies | **nobody can sign in**, and the recovery key does not help |
| `blobs/` | the encrypted photos and videos | those files are gone |

A backup (`backup/app.db`, `backup/secret`, `blobs/`) contains all three. Never copy `app.db` by hand while the app
runs: use the backup, it takes a consistent snapshot first.

## Before you start

- The new machine runs **the same or a newer version**. Database changes are applied automatically when a newer
  version starts; going back to an older version is not supported.
- Tell the people on the instance not to upload during the move. Uploads after the backup are not in it.
- The new address will differ (for example `https://fotocrypt.orb.local` becomes `https://photos.example.com`).
  Everyone signs in once at the new address. Invite links made on the old instance point to the old address:
  revoke unused ones there and create new ones after the move.

## 1. Back up the old instance

On the Mac setup:

```bash
cd ~/Desktop/fotocrypt
./fotocrypt.sh backup            # writes backups/fotocrypt-YYYYMMDD-HHMMSS.tar
```

On a server set up from this repository:

```bash
scripts/backup.sh ./backups      # writes backups/cipherfilm-YYYYMMDD-HHMMSS.tar
```

Both files have the same format. Before you rely on it, check that it can be decrypted, with no server involved:

```bash
mkdir check && tar -xf backups/fotocrypt-....tar -C check
./cipherfilm-decrypt-darwin-arm64 --verify --email you@example.org check
```

The decrypt tool for every platform is attached to each release on GitHub.

## 2. Prepare the new machine

For a fresh VPS, lock it down first: [SERVER-HARDENING.md](SERVER-HARDENING.md). You need Docker with Compose.
Then:

```bash
git clone https://github.com/basmatiactivist/cipherfilm.git /opt/cipherfilm
cd /opt/cipherfilm
cp .env.example .env
```

In `.env`:

1. Set `PUBLIC_HOSTS` to the name your HTTPS proxy serves (any proxy; requirements in
   [SELF-HOSTING.md](SELF-HOSTING.md#deploy)).
2. Use the released image instead of building: `CIPHERFILM_IMAGE=ghcr.io/basmatiactivist/cipherfilm:2` (public, no
   sign-in needed).

Do **not** start the app yet: a fresh start creates a new, empty instance with its own secret. `restore.sh` sets
everything up itself (an accidental first start is harmless, the restore replaces it).

## 3. Copy the backup over

```bash
scp ~/Desktop/fotocrypt/backups/fotocrypt-....tar you@server:/opt/cipherfilm/
```

The file contains only ciphertext, but treat it like a password vault anyway: `secret` is in it.

## 4. Restore on the new machine

```bash
cd /opt/cipherfilm
docker compose pull
scripts/restore.sh fotocrypt-....tar --yes
```

The script checks the archive before it deletes anything, restores the data into the volume, ends every session,
starts the app and prints a health report. Look for `integrity: ok` and `0 missing` files, and that the number of
users and items matches the old instance. You can repeat this check at any time with
`docker compose exec app /app check`.

## 5. Check, then switch over

1. Open the new address, sign in, open a few photos and play a video.
2. Admin, Server: the version and the data size match what you expect.
3. Set up automatic backups on the new machine ([SELF-HOSTING.md](SELF-HOSTING.md#backup-and-restore)) and test
   one.
4. Only then stop the old instance: `./fotocrypt.sh stop`. Keep its `data/` folder and the backup for a while
   before you delete them. Until then you can go back at any time.

## Moving back or between servers

The same steps in any direction: `scripts/backup.sh` (or `./fotocrypt.sh backup`) on the old machine,
`scripts/restore.sh` (or `./fotocrypt.sh restore … --yes`) on the new one.
