#!/bin/sh
# End-to-end test of cipherfilm-upload on this Mac, against a throwaway server in Docker (never a real instance):
# creates an account, uploads drawn test photos and a video, interrupts and resumes, re-runs to see duplicates
# skipped, checks thumbnails and metadata like the web app, and restores the originals with cipherfilm-decrypt.
#   tools/upload/e2e/run.sh            (needs Docker and Xcode's command line tools for swift)
set -eu
cd "$(dirname "$0")"
here=$(pwd)
tools=$(cd ../.. && pwd)
C="docker compose -f compose.yaml"
work=$(mktemp -d "${TMPDIR:-/tmp}/cf-upload-e2e.XXXXXX")
export CF_EMAIL=uploader@example.org CF_PASSWORD="e2e-only password ü"
trap '$C down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
# go [docker run options] -- command: runs in a Go container with this tool's source
go() {
  opts=""
  while [ "$1" != -- ]; do opts="$opts $1"; shift; done
  shift
  # shellcheck disable=SC2086
  docker run --rm -v gocache:/go/pkg/mod -v "$tools:/tools" -v "$work:/work" -w /tools/upload $opts golang:1.27-alpine "$@"
}

echo "== server"
$C down -v --remove-orphans >/dev/null 2>&1 || true
$C up -d --build --wait
token=$($C logs app | grep -o 'token: .*' | tail -1 | cut -c8-)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sk https://localhost:8463/healthz >/dev/null && $C exec -T proxy cat /data/caddy/pki/authorities/local/root.crt >"$work/ca.pem" 2>/dev/null && break
  sleep 1
done
printf %s "$CF_PASSWORD" >"$work/pw"
net="cipherfilm-uploadtest_default"
go --network "$net" -e CF_URL=https://proxy -e CF_CA=/work/ca.pem -e CF_EMAIL -e CF_PASSWORD -e CF_SETUP_TOKEN="$token" -- \
  go test -tags e2e -count=1 -run TestE2ECreateAccount .

echo "== build for this Mac"
arch=$(uname -m); [ "$arch" = x86_64 ] && arch=amd64
go -e CGO_ENABLED=0 -e GOOS=darwin -e GOARCH="$arch" -- go build -o /work/cipherfilm-upload .
bin="$work/cipherfilm-upload"

echo "== test photos"
mkdir -p "$work/photos"
swift samples.swift "$work/photos" 2>/dev/null
head -c 104857600 /dev/urandom >"$work/photos/Trip/long.mp4" # 100 MB that is not a real video: uploads without a thumbnail
cp -p "$work/photos/IMG_0001.JPG" "$work/photos/Trip/Day 2/IMG_0001.JPG" # the same photo twice: uploaded once
echo skip >"$work/photos/notes.txt"
cp "$work/photos/Trip/Day 2/screen.png" "$work/photos/Trip/.hidden.png"
expect=6 # IMG_0001.JPG, IMG_0002.HEIC, screen.png, small.gif, clip.mov, long.mp4

up() { "$bin" --server https://localhost:8463 --email "$CF_EMAIL" --password-file "$work/pw" --ca-file "$work/ca.pem" "$@" "$work/photos"; }
export CIPHERFILM_UPLOAD_STATE="$work/state"

echo "== upload, interrupted"
"$bin" --server https://localhost:8463 --email "$CF_EMAIL" --password-file "$work/pw" --ca-file "$work/ca.pem" \
  --parallel 1 --segments 1 "$work/photos" >"$work/run1.log" 2>&1 &
pid=$!
# stop it once the big file (the last one) has started: the resume file then lists it as unfinished
for _ in $(seq 1 400); do
  if grep -q 'long\.mp4[^}]*"w":' "$work/state/"*.jsonl 2>/dev/null; then break; fi
  sleep 0.02
done
# a local server is too fast to catch mid-file: freeze it (the upload hangs as on a dead line), then stop the run.
# SIGTERM takes the same path as Ctrl-C; SIGINT itself is ignored by jobs a script starts in the background.
$C pause proxy >/dev/null
sleep 1
kill -TERM $pid 2>/dev/null || true
code=0; wait $pid || code=$?
$C unpause proxy >/dev/null
cat "$work/run1.log" | tr '\r' '\n' | grep -v '^\s*$' | tail -4
[ $code = 130 ] || { echo "FAIL: the first run was not interrupted (exit code $code)"; exit 1; }

echo "== upload again: continues"
up >"$work/run2.log" 2>&1 || { cat "$work/run2.log"; exit 1; }
tr '\r' '\n' <"$work/run2.log" | grep -v '^\s*$' | tail -3
grep -q "Uploaded 1, already done earlier 5" "$work/run2.log" || { echo "FAIL: the interrupted file was not continued"; exit 1; }

echo "== third run, fresh resume file: everything is already in the library"
CIPHERFILM_UPLOAD_STATE="$work/state2" up >"$work/run3.log" 2>&1 || { cat "$work/run3.log"; exit 1; }
tr '\r' '\n' <"$work/run3.log" | grep -v '^\s*$' | tail -2
grep -q "Uploaded 0, already done earlier 0, already in the library 7" "$work/run3.log" || { echo "FAIL: duplicates not skipped"; exit 1; }

echo "== check the library like the web app"
go --network "$net" -e CF_URL=https://proxy -e CF_CA=/work/ca.pem -e CF_EMAIL -e CF_PASSWORD -e CF_EXPECT=$expect -- \
  go test -tags e2e -count=1 -v -run TestE2ECheckLibrary . | grep -v '^=== '

echo "== restore with cipherfilm-decrypt and compare"
docker run --rm -v gocache:/go/pkg/mod -v "$tools/decrypt:/src" -v cipherfilm-uploadtest_data:/data:ro -v "$work:/work" -w /src golang:1.27-alpine \
  sh -c 'go run . --verify --email "$0" --password-file /work/pw /data && go run . --email "$0" --password-file /work/pw --out /work/restored /data >/dev/null' "$CF_EMAIL"
missing=0
for f in IMG_0001.JPG Trip/IMG_0002.HEIC "Trip/Day 2/screen.png" "Trip/Day 2/small.gif" Trip/clip.mov Trip/long.mp4; do
  sum=$(shasum -a 256 <"$work/photos/$f" | cut -d' ' -f1)
  if find "$work/restored" -type f -exec shasum -a 256 {} + | grep -q "^$sum "; then echo "  restored intact: $f"; else echo "  MISSING or changed: $f"; missing=1; fi
done
[ $missing = 0 ] || exit 1
echo "end-to-end test passed"
