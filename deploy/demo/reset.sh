#!/bin/sh
# Puts the demo server back to its seed, a backup made with scripts/backup.sh (README.md). Run hourly by a timer:
# whatever visitors did in the last hour (their search index, their sign-ins) is gone, and so is the replaced data that
# restore.sh would keep in .previous/. Runs from the Cipherfilm checkout, with its .env (COMPOSE_FILE, DATA_VOLUME).
#   deploy/demo/reset.sh [seed.tar]            (default deploy/demo/seed.tar)
set -eu
cd "$(dirname "$0")/../.."
SEED="${1:-deploy/demo/seed.tar}"
[ -f "$SEED" ] || { echo "no seed at $SEED (README.md, 'The seed')" >&2; exit 2; }
scripts/restore.sh "$SEED" --yes
docker run --rm -v "${DATA_VOLUME:-cipherfilm_data}":/data alpine:3.24 rm -rf /data/.previous
