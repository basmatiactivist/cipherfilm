# Off-site backups with Kopia

`scripts/backup.sh` writes a tar file next to the server. For a copy somewhere else, every night, `compose.kopia.yaml`
adds [Kopia](https://kopia.io) to the Tailscale setup. Kopia saves to any repository it supports (WebDAV such as
Nextcloud, S3, SFTP, Backblaze B2, ...), only uploads what changed, and encrypts with the repository password.
Its web UI is at `https://<TS_HOSTNAME>.<your-tailnet>.ts.net:8443`, reachable only in your tailnet, behind its own
login. Nothing is published on the host.

What it saves is what `backup.sh` saves: `backup/` (a consistent database snapshot and the server secret) and
`blobs/` (the encrypted files). The live database is skipped; a nightly run first writes the snapshot, then Kopia
saves, so every file the snapshot refers to is in the backup. The photos, videos and their metadata in it are
ciphertext already, but the database snapshot also holds e-mail addresses, password verifiers and wrapped keys, and
`backup/` holds the server secret: keep the repository password and the off-site store as private as the server.

## Set up

1. In `.env`:

   ```
   COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.kopia.yaml
   KOPIA_SERVER_PASSWORD='a long password for the UI'
   ```

   Keep the single quotes: without them Compose treats a `$` in the password as a variable and cuts it off.
2. `docker compose up -d`, then open `https://<name>.<tailnet>.ts.net:8443` and sign in as `admin`.
3. Connect to your repository (an existing one is fine: Kopia keeps each machine's snapshots apart), or create
   one. For Nextcloud choose *WebDAV Server* with
   `https://<cloud>/remote.php/dav/files/<user>/<folder>` and a Nextcloud app password.
4. Name this client and set what to save and how long to keep it:

   ```bash
   docker compose exec kopia kopia repository set-client --hostname=cipherfilm --username=cipherfilm
   docker compose restart kopia
   docker compose exec kopia kopia policy set /data \
     --add-ignore /app.db --add-ignore /app.db-wal --add-ignore /app.db-shm --add-ignore /secret --add-ignore /.restore --add-ignore /backup.new --add-ignore /backup.old --add-ignore /backup.lock --add-ignore /.previous \
     --compression none --keep-latest 10 --keep-hourly 0 --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --keep-annual 3
   docker compose exec kopia kopia cache set --content-cache-size-limit-mb=500 --metadata-cache-size-limit-mb=500
   ```

   Compression is off: encrypted files don't compress.
5. Run it every night. With systemd, `/etc/systemd/system/cipherfilm-snapshot.service`:

   ```
   [Unit]
   Description=Cipherfilm database snapshot and Kopia backup
   After=docker.service
   [Service]
   Type=oneshot
   WorkingDirectory=/opt/cipherfilm
   ExecStart=/bin/sh scripts/kopia-snapshot.sh
   TimeoutStartSec=12h
   ```

   and `/etc/systemd/system/cipherfilm-snapshot.timer`:

   ```
   [Unit]
   Description=Nightly Cipherfilm backup (Kopia)
   [Timer]
   OnCalendar=*-*-* 03:15:00
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

   `systemctl daemon-reload && systemctl enable --now cipherfilm-snapshot.timer`, then
   `systemctl start cipherfilm-snapshot.service` once and check `journalctl -u cipherfilm-snapshot.service`.

The first run uploads everything and can take hours; later runs only send new files. Each run reports its outcome to
Cipherfilm: **Admin → Server → Off-site backup** shows the last successful run, and every admin page shows a
warning when the last run failed or none has succeeded for a day and a half. Kopia's UI has the details.

## Restore

Into an empty folder, on any machine that can reach the repository (or in the UI: *Snapshots* → *Restore*):

```bash
kopia snapshot list cipherfilm@cipherfilm:/data
kopia restore <snapshot-id> restore-me
```

`restore-me` now holds `backup/` and `blobs/`. Two ways on from there:

- **Back into Cipherfilm:** pack it the way `backup.sh` does and restore that:
  `tar -cf cipherfilm-restore.tar -C restore-me backup blobs`, then `scripts/restore.sh cipherfilm-restore.tar --yes`.
- **Straight to your photos, without the app:** `cipherfilm-decrypt --email you@example.org --out ~/Pictures/restored restore-me`
  (see [TOOLS.md](TOOLS.md#getting-your-photos-back-without-the-app)).
