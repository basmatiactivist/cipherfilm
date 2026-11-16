#!/bin/sh
# Puts the demo server back to its seed, a backup made with scripts/backup.sh (README.md). Run daily by a timer:
# whatever visitors did since the last reset (their search index, their sign-ins) is gone, and so is the replaced data that
# restore.sh would keep in .previous/. Runs from the Cipherfilm checkout, with its .env (COMPOSE_FILE, DATA_VOLUME).
#   deploy/demo/reset.sh [seed.tar]            (default deploy/demo/seed.tar)
# The restore keeps the accounts' roles and states as they were before it (server/backup.go carryAccounts). For the
# reviewer accounts they are put back afterwards, so what an administrator login handed to a store did to them lasts a
# day at most (README.md, "Reviewer accounts"); both lists are e-mail addresses separated by spaces, e.g. from the unit:
#   DEMO_ADMINS="reviewer2@example.org"   enabled and administrators
#   DEMO_USERS="reviewer@example.org"     enabled and regular users
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
failed=0
if [ -n "${DEMO_ADMINS:-}${DEMO_USERS:-}" ]; then
  users="$(docker compose exec -T app /app list-users)" || failed=1
  unlock() { # only a locked account: an account already active gets no new entry in the activity log
    if printf '%s\n' "$users" | awk -v e="$1" '$1 == e && $3 == "disabled" { f = 1 } END { exit !f }'; then
      docker compose exec -T app /app enable-user "$1" || failed=1
    fi
  }
  # administrators first, so that taking the role from someone never meets "the only active administrator"
  for e in ${DEMO_ADMINS:-}; do unlock "$e"; docker compose exec -T app /app make-admin "$e" || failed=1; done
  for e in ${DEMO_USERS:-}; do unlock "$e"; docker compose exec -T app /app revoke-admin "$e" || failed=1; done
fi
docker run --rm -v "$VOLUME":/data alpine:3.24 sh -c '[ ! -e /data/.restore-pending ] && rm -rf /data/.previous'
[ "$failed" = 0 ] || { echo "the reviewer accounts' roles could not all be put back: check with /app list-users" >&2; exit 1; }
