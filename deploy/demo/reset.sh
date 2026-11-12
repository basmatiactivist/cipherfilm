#!/bin/sh
# Puts the demo server back to its seed, a backup made with scripts/backup.sh (README.md). Run daily by a timer:
# whatever visitors did since the last reset (their search index, their sign-ins) is gone, and so is the replaced data that
# restore.sh would keep in .previous/. Runs from the Cipherfilm checkout, with its .env (COMPOSE_FILE, DATA_VOLUME).
#   deploy/demo/reset.sh [seed.tar]            (default deploy/demo/seed.tar)
set -eu
cd "$(dirname "$0")/../.."
SEED="${1:-deploy/demo/seed.tar}"
[ -f "$SEED" ] || { echo "no seed at $SEED (README.md, 'The seed')" >&2; exit 2; }
# a run that failed before (after-restore did not succeed) left .restore-pending: stop, a person has to look
# (restore.sh refuses too; this says why before anything is stopped)
VOLUME="${DATA_VOLUME:-cipherfilm_data}"
if ! docker run --rm -v "$VOLUME":/data alpine:3.24 sh -c '[ ! -e /data/.restore-pending ]'; then
  echo "an earlier reset did not finish (.restore-pending in the volume): not resetting again; see scripts/restore.sh" >&2
  exit 1
fi
scripts/restore.sh "$SEED" --yes
docker run --rm -v "$VOLUME":/data alpine:3.24 sh -c '[ ! -e /data/.restore-pending ] && rm -rf /data/.previous'
