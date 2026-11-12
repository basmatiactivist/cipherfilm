#!/bin/sh
# make prod-config: every setting the server reads (os.Getenv in server/) must reach the app from .env through
# compose.yaml; one that is documented for .env but not passed on is silently ignored.
set -eu
cd "$(dirname "$0")/.."
vars="$(grep -ho 'Getenv("[A-Z_]*")' $(ls server/*.go | grep -v _test) | sed 's/.*("\(.*\)")/\1/' | sort -u)"
for v in $vars; do
  case "$v" in DATA_DIR | LISTEN_ADDR) continue ;; esac   # fixed by the image and compose.yaml
  if ! env PUBLIC_HOSTS=photos.example.com "$v=cf-env-check" docker compose -f compose.yaml config | grep -q "$v: cf-env-check"; then
    echo "compose.yaml does not pass $v to the app" >&2
    exit 1
  fi
done
echo "every server setting from .env reaches the app"
