#!/bin/sh
# Nightly off-site backup with Kopia (deploy/tailnet/compose.kopia.yaml): first a consistent database snapshot, then Kopia saves
# backup/ (that snapshot and the secret) and blobs/. Database first, files second, as in backup.sh: every file the
# snapshot refers to is in the backup. The outcome shows under Admin > Server. Run from the directory with .env,
# e.g. from a systemd timer.
set -u
report() { docker compose exec -T app /app backup-report "$@" </dev/null || echo "could not record the outcome" >&2; }

if ! docker compose exec -T app /app backup </dev/null; then
  report failed snapshot
  exit 1
fi
if ! docker compose exec -T kopia kopia snapshot create /data --description "nightly" </dev/null; then
  report failed upload
  exit 1
fi
report ok
