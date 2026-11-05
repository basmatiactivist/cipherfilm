#!/bin/sh
# Restores a backup made by backup.sh. REPLACES everything in the data volume; what it replaces is kept in .previous/.
#   scripts/restore.sh path/to/cipherfilm-YYYYMMDD-HHMMSS.tar --yes
# The archive is checked BEFORE anything is deleted: required members must exist, and members that are not plain
# files or directories (symlinks, devices) or that try to leave the data directory are rejected.
set -eu
FILE="${1:-}"
[ -f "$FILE" ] || { echo "usage: $0 backup.tar --yes" >&2; exit 2; }
[ "${2:-}" = "--yes" ] || { echo "This replaces ALL data in the volume with the backup. Re-run with --yes to confirm." >&2; exit 2; }
VOLUME="${DATA_VOLUME:-cipherfilm_data}"
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

echo "checking the archive ..."
docker run --rm -v "$FILE":/in.tar:ro alpine:3.24 sh -ec '
  tar -tf /in.tar > /tmp/names
  tar -tvf /in.tar > /tmp/long
  grep -qx "backup/app.db" /tmp/names || { echo "archive has no backup/app.db" >&2; exit 1; }
  grep -qx "backup/secret" /tmp/names || { echo "archive has no backup/secret" >&2; exit 1; }
  if grep -E "^/|(^|/)\.\.(/|$)" /tmp/names >/dev/null; then echo "archive has unsafe paths" >&2; exit 1; fi
  if grep -v "^[-d]" /tmp/long >/dev/null; then echo "archive has members that are not plain files or directories" >&2; exit 1; fi
  if grep -Ev "^(backup|blobs)(/|$)" /tmp/names >/dev/null; then echo "archive has unexpected top-level members" >&2; exit 1; fi
'

echo "stopping the app ..."
docker compose stop app >/dev/null
if [ -n "$(docker compose ps -q --status running app)" ]; then
  echo "the app is still running; not touching its data" >&2
  exit 1
fi
docker compose create app >/dev/null   # makes Compose own the data volume (also on a brand-new host)
echo "restoring into volume $VOLUME ..."
docker run --rm -v "$VOLUME":/data -v "$FILE":/in.tar:ro alpine:3.24 sh -ec '
  # an earlier run that stopped half-way may have left the live data only in .previous: never drop that
  if [ -e /data/.restore ] || { [ ! -e /data/app.db ] && [ -e /data/.previous/app.db ]; }; then
    echo "an earlier restore did not finish. Check /data/.previous (it may hold the live data) and /data/.restore," >&2
    echo "move the data back or remove them by hand, then run this again" >&2
    exit 1
  fi
  mkdir /data/.restore
  tar -xf /in.tar -C /data/.restore                    # extract aside first; nothing is touched if this fails
  [ -d /data/.restore/blobs ] || mkdir /data/.restore/blobs   # no blobs/ until the first upload
  { [ -f /data/.restore/backup/app.db ] && [ -f /data/.restore/backup/secret ]; } || { echo "the archive lacks backup/app.db or backup/secret" >&2; exit 1; }
  # the data being replaced is moved aside, not deleted (a rename, so it needs no extra space): if this was the
  # wrong archive, /data/.previous still holds everything up to now. An older .previous is dropped.
  rm -rf /data/.previous && mkdir /data/.previous
  for f in blobs app.db app.db-wal app.db-shm secret backup; do [ ! -e "/data/$f" ] || mv "/data/$f" /data/.previous/; done
  mv /data/.restore/blobs /data/blobs
  mv /data/.restore/backup/app.db /data/app.db
  mv /data/.restore/backup/secret /data/secret
  rm -rf /data/.restore
  chown -R 65532:65532 /data
'
# before the app serves anything: end every session the backup brings back (some were revoked since), and give
# items in the restored trash a fresh 30 days, so the restore doesn't purge exactly what it was meant to bring back
docker compose run --rm --no-deps -T app after-restore
echo "starting the app ..."
docker compose up -d app
sleep 2
docker compose exec -T app /app check
echo "The data that was replaced is in the volume under .previous/. Once the restore looks right, remove it with:"
echo "  docker run --rm -v $VOLUME:/data alpine:3.24 rm -rf /data/.previous"
