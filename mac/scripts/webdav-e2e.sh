#!/bin/sh
# End-to-end test of the Mac app's WebDAV import (docs/MAC.md), on this Mac, against a throwaway Cipherfilm server in
# Docker (tools/upload/e2e/compose.yaml, never a real instance) and a local WebDAV server (rclone serve webdav): a flat
# folder of a few hundred drawn photos, the uploader's samples and one large video with its moov box at the end (a .mov: ffmpeg writes a place only there), plus
# a subfolder and a text file that must be left alone. The Swift test imports it (interrupted once and resumed),
# measures disk, memory and throughput, and checks dedupe and metadata; then the library is checked like the web app
# does and the large video is restored with cipherfilm-decrypt and compared. Everything is deleted at the end.
#   mac/scripts/webdav-e2e.sh            (needs Docker, rclone, ffmpeg, openssl and Xcode's command line tools)
#   PHOTOS=300 VIDEO_SECONDS=60 mac/scripts/webdav-e2e.sh
set -eu
cd "$(dirname "$0")/.."
mac=$(pwd)
tools=$(cd ../tools && pwd)
port=${PORT:-8473} # not the upload tool's 8463, so it runs next to a test server kept up for trying the app
work=$(mktemp -d "${TMPDIR:-/tmp}/cf-webdav-e2e.XXXXXX")
printf 'services:\n  proxy:\n    ports: !override\n      - "127.0.0.1:%s:443"\n' "$port" >"$work/port.yaml"
C="docker compose -p cipherfilm-webdavtest -f $tools/upload/e2e/compose.yaml -f $work/port.yaml"
net="cipherfilm-webdavtest_default"
export CF_EMAIL=webdav@example.org CF_PASSWORD="e2e-only password ü"
dav_pass=$(openssl rand -hex 16)
pids=""
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  $C down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
go() {
  opts=""
  while [ "$1" != -- ]; do opts="$opts $1"; shift; done
  shift
  # shellcheck disable=SC2086
  docker run --rm -v gocache:/go/pkg/mod -v "$tools:/tools" -v "$work:/work" -w /tools/upload $opts golang:1.27-alpine "$@"
}

echo "== test files"
mkdir -p "$work/dav/Sub" "$work/samples"
swift scripts/webdav-e2e-samples.swift "$work/dav" "${PHOTOS:-300}" big
swift "$tools/upload/e2e/samples.swift" "$work/samples" 2>/dev/null
find "$work/samples" -type f -exec mv {} "$work/dav/" \;
ffmpeg -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t "${VIDEO_SECONDS:-60}" -c:v libx264 -preset ultrafast -b:v 60M \
  -metadata creation_time=2021-06-15T10:00:00Z -metadata location="+47.3769+008.5417/" -pix_fmt yuv420p -f mov "$work/dav/big.mov"
echo "not a photo" >"$work/dav/notes.txt"
cp "$work/dav/gen-0001.jpg" "$work/dav/Sub/inside.jpg"
cp "$work/dav/gen-0002.jpg" "$work/dav/.hidden.jpg"
du -sh "$work/dav"; ls "$work/dav" | wc -l

echo "== WebDAV servers"
rclone serve webdav "$work/dav" --addr 127.0.0.1:8092 --user cfimport --pass "$dav_pass" >"$work/rclone.log" 2>&1 &
pids="$pids $!"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/k.pem" -out "$work/c.pem" -subj /CN=localhost -days 1 2>/dev/null
rclone serve webdav "$work/dav" --addr 127.0.0.1:8093 --cert "$work/c.pem" --key "$work/k.pem" --user cfimport --pass "$dav_pass" >/dev/null 2>&1 &
pids="$pids $!"

echo "== server"
$C down -v --remove-orphans >/dev/null 2>&1 || true
$C up -d --build --wait
token=$($C logs app | grep -o 'token: .*' | tail -1 | cut -c8-)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sk "https://localhost:$port/healthz" >/dev/null && $C exec -T proxy cat /data/caddy/pki/authorities/local/root.crt >"$work/ca.pem" 2>/dev/null && break
  sleep 1
done
go --network "$net" -e CF_URL=https://proxy -e CF_CA=/work/ca.pem -e CF_EMAIL -e CF_PASSWORD -e CF_SETUP_TOKEN="$token" -- \
  go test -tags e2e -count=1 -run TestE2ECreateAccount .

echo "== import"
expect=$(find "$work/dav" -maxdepth 1 -type f ! -name '.*' ! -name '*.txt' | wc -l | tr -d ' ')
CF_WEBDAV_E2E=1 CF_URL="https://localhost:$port" CF_TEST_CA="$work/ca.pem" CF_WEBDAV=http://127.0.0.1:8092/ CF_WEBDAV_SELFSIGNED=https://localhost:8093/ \
  CF_WEBDAV_USER=cfimport CF_WEBDAV_PASS="$dav_pass" CF_TEMP="$work/tmp/webdav" CF_REPORT="$work/report.txt" \
  swift test --filter WebDAVE2ETests >"$work/swift.log" 2>&1 || true
grep -E "✔|✘|Expectation|recorded|error:" "$work/swift.log" | grep -v "^warning" | head -40
if grep -q "✘" "$work/swift.log" || [ ! -s "$work/report.txt" ]; then
  [ -n "${KEEP_LOG:-}" ] && cp "$work/swift.log" "$KEEP_LOG"
  echo "FAIL: the import test failed"; exit 1
fi
cat "$work/report.txt"

echo "== check the library like the web app"
go --network "$net" -e CF_URL=https://proxy -e CF_CA=/work/ca.pem -e CF_EMAIL -e CF_PASSWORD -e CF_EXPECT="$expect" -- \
  go test -tags e2e -count=1 -v -run TestE2ECheckLibrary . >"$work/check.log" 2>&1 || { grep -v -e '^=== ' -e 'e2e_test.go:146:' "$work/check.log" | tail -30; echo "FAIL: library check"; exit 1; }
grep -E 'big.mov|IMG_0001|clip.mov|screen|gen-0001|^ok|PASS' "$work/check.log"

echo "== restore with cipherfilm-decrypt and compare"
printf %s "$CF_PASSWORD" >"$work/pw"
docker run --rm -v gocache:/go/pkg/mod -v "$tools/decrypt:/src" -v cipherfilm-webdavtest_data:/data:ro -v "$work:/work" -w /src golang:1.27-alpine \
  sh -c 'go run . --email "$0" --password-file /work/pw --out /work/restored /data >/dev/null' "$CF_EMAIL"
missing=0
for f in big.mov IMG_0001.JPG IMG_0002.HEIC clip.mov gen-0150.jpg; do
  sum=$(shasum -a 256 <"$work/dav/$f" | cut -d' ' -f1)
  if find "$work/restored" -type f -exec shasum -a 256 {} + | grep -q "^$sum "; then echo "  restored intact: $f"; else echo "  MISSING or changed: $f"; missing=1; fi
done
[ $missing = 0 ] || exit 1
echo "WebDAV end-to-end test passed"
