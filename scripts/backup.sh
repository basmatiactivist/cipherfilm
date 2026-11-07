#!/bin/sh
# Backs up the database and the encrypted files into one tar file. Safe to run while the app is running.
#   scripts/backup.sh [destination-dir]        (default ./backups)
# Uses compose.yaml (or the files in COMPOSE_FILE). Set DATA_VOLUME if you changed the volume name.
set -eu
DEST="${1:-./backups}"
VOLUME="${DATA_VOLUME:-cipherfilm_data}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="cipherfilm-$STAMP.tar"

echo "1/2 snapshotting the database ..."
docker compose exec -T app /app backup
echo "2/2 copying the encrypted files ..."   # database first, files second: see docs in README
# written under a temporary name and listed back before it gets its real name: a failed copy (a full disk, say)
# ends the script with an error and leaves no archive that looks complete
docker run --rm -v "$VOLUME":/data:ro -v "$DEST":/out alpine:3.24 sh -ec '
  umask 077
  trap "rm -f \"/out/$0.part\"" EXIT
  if [ -d /data/blobs ]; then tar -cf "/out/$0.part" -C /data backup blobs; else tar -cf "/out/$0.part" -C /data backup; fi  # no blobs/ until the first upload
  tar -tf "/out/$0.part" >/dev/null
  mv "/out/$0.part" "/out/$0"
  trap - EXIT' "$FILE"
echo "done: $DEST/$FILE"
echo "Keep it somewhere that is NOT this machine. It holds only encrypted data, plus the server's login-hash secret."
