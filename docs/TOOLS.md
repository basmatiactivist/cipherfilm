# Tools

Command-line tools for big uploads and for getting your photos back without the app, and a ready-made setup for
running Cipherfilm on your own Mac.

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
Moving to a server later is a backup, a copy and `scripts/restore.sh`: step by step in [docs/MIGRATION.md](MIGRATION.md).
