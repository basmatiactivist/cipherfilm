#!/bin/sh
# Offline checks of scripts/restore.sh and deploy/demo/reset.sh (make restore-test): no Docker, no network. A stand-in
# `docker` on PATH runs the scripts' container steps on a local folder as the data volume, and plays the app's
# after-restore step (FAKE_AFTER_RESTORE=fail makes it fail). Checks that a failed after-restore leaves the restore
# marked as pending, and that neither a second restore nor the demo reset then drops .previous/ (the live data).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cf-restore-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/tmp" "$WORK/vol" "$WORK/seed/backup" "$WORK/seed/blobs"

# the stand-in docker: `run ... -v SRC:DST ... IMAGE sh -c|-ec SCRIPT` runs SCRIPT here with each DST replaced by SRC
cat > "$WORK/bin/docker" <<'EOF'
#!/bin/sh
set -eu
case "$1" in
compose)
  shift
  case "$*" in
  *after-restore*)
    [ "${FAKE_AFTER_RESTORE:-ok}" = ok ] || { echo "fake after-restore: failing" >&2; exit 1; }
    rm -f "$FAKE_VOLUME/.restore-pending" ;;
  "ps "*) ;;                       # nothing running
  *) ;;                            # stop, create, up, exec check
  esac
  exit 0 ;;
run)
  shift
  subst=""
  while [ $# -gt 0 ]; do
    case "$1" in
    --rm) shift ;;
    -v) m="${2%:ro}"; subst="$subst -e s|${m#*:}|${m%%:*}|g"; shift 2 ;;
    alpine:*) shift; break ;;
    *) shift ;;
    esac
  done
  [ "$1" = sh ] || { echo "fake docker: unexpected command $*" >&2; exit 2; }
  flags="$2"; script="$3"
  # /tmp first, so the paths put in for /data and /in.tar are not rewritten again
  script="$(printf '%s' "$script" | sed -e "s|/tmp/|$FAKE_TMP/|g" $subst)"
  exec sh "$flags" "$script" ;;
*) echo "fake docker: $*" >&2; exit 2 ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/chown"   # the test does not run as root
chmod +x "$WORK/bin/docker" "$WORK/bin/chown"
export PATH="$WORK/bin:$PATH" DATA_VOLUME="$WORK/vol" FAKE_VOLUME="$WORK/vol" FAKE_TMP="$WORK/tmp"

echo backup-db > "$WORK/seed/backup/app.db"
echo backup-secret > "$WORK/seed/backup/secret"
tar -cf "$WORK/seed.tar" -C "$WORK/seed" backup blobs
live() { mkdir -p "$WORK/vol/blobs"; echo "$1" > "$WORK/vol/app.db"; echo live-secret > "$WORK/vol/secret"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cd "$ROOT"

# 1. a restore that succeeds: backup in place, replaced data in .previous, no mark
live live-1
scripts/restore.sh "$WORK/seed.tar" --yes > "$WORK/out" 2>&1 || { cat "$WORK/out"; fail "restore"; }
[ "$(cat "$WORK/vol/app.db")" = backup-db ] || fail "backup not in place"
[ "$(cat "$WORK/vol/.previous/app.db")" = live-1 ] || fail "replaced data not in .previous"
[ ! -e "$WORK/vol/.restore-pending" ] || fail "mark left after a good restore"
echo "ok   restore"

# 2. after-restore fails: the mark stays, .previous holds the live data
rm -rf "$WORK/vol" && mkdir "$WORK/vol" && live live-2
if FAKE_AFTER_RESTORE=fail scripts/restore.sh "$WORK/seed.tar" --yes > "$WORK/out" 2>&1; then fail "a failed after-restore went unnoticed"; fi
[ -e "$WORK/vol/.restore-pending" ] || fail "no mark after a failed after-restore"
[ "$(cat "$WORK/vol/.previous/app.db")" = live-2 ] || fail "live data not in .previous"
echo "ok   failed after-restore leaves the mark"

# 3. running it again refuses and keeps .previous
if scripts/restore.sh "$WORK/seed.tar" --yes > "$WORK/out" 2>&1; then fail "second restore ran over a pending one"; fi
grep -q "not finished" "$WORK/out" || { cat "$WORK/out"; fail "no reason given"; }
[ "$(cat "$WORK/vol/.previous/app.db")" = live-2 ] || fail "second restore dropped the live data"
echo "ok   rerun refuses"

# 4. the demo reset stops too, and keeps .previous
if deploy/demo/reset.sh "$WORK/seed.tar" > "$WORK/out" 2>&1; then fail "demo reset ran over a pending restore"; fi
[ "$(cat "$WORK/vol/.previous/app.db")" = live-2 ] || fail "demo reset dropped the live data"
echo "ok   demo reset stops"

# 5. once after-restore succeeded, the demo reset works again and clears .previous
rm "$WORK/vol/.restore-pending"
deploy/demo/reset.sh "$WORK/seed.tar" > "$WORK/out" 2>&1 || { cat "$WORK/out"; fail "demo reset"; }
[ ! -e "$WORK/vol/.previous" ] || fail "demo reset kept .previous"
[ "$(cat "$WORK/vol/app.db")" = backup-db ] || fail "demo reset did not restore"
echo "ok   demo reset"
echo "restore-test: all passed"
