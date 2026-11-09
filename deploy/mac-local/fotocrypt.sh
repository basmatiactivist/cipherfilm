#!/bin/sh
# fotocrypt: start, stop and look after your Cipherfilm instance.  ./fotocrypt.sh help
set -eu
cd "$(dirname "$0")"
URL="https://fotocrypt.orb.local"
cmd="${1:-help}"
case "$cmd" in
  start)   docker compose up -d && echo "läuft: $URL" ;;
  stop)    docker compose stop && echo "gestoppt (deine Daten bleiben in ./data)" ;;
  restart) docker compose restart && echo "neu gestartet: $URL" ;;
  status)  docker compose ps; echo; docker compose exec -T app /app check 2>&1 | tail -5 || true ;;
  logs)    docker compose logs -f --tail 100 app ;;
  open)    open "$URL" ;;
  token)   # Setup token for the FIRST account. A new one is made at every start until the first admin exists.
           T="$(docker compose logs app 2>&1 | grep -o 'token: .*' | tail -1 | cut -c8-)"
           if [ -n "$T" ]; then ( umask 077; printf '%s\n' "$T" > SETUP-TOKEN.txt ); echo "Token steht in $PWD/SETUP-TOKEN.txt"; else echo "Kein Token: das erste Konto existiert schon."; fi ;;
  backup)
    # database snapshot first, encrypted files second, so every item in the snapshot has its files
    docker compose exec -T app /app backup >/dev/null
    STAMP="$(date +%Y%m%d-%H%M%S)"; FILE="backups/fotocrypt-$STAMP.tar"
    if [ -d data/blobs ]; then ( umask 077; tar -cf "$FILE" -C data backup blobs ); else ( umask 077; tar -cf "$FILE" -C data backup ); fi  # no blobs folder until the first upload
    echo "Sicherung: $PWD/$FILE"
    echo "Lege sie ausserhalb dieses Macs ab (externe Platte, anderer Rechner). Sie enthaelt nur verschluesselte Daten."
    ;;
  export)
    # Holt deine Originalfotos direkt aus ./data, ohne Sicherung und ohne laufende App.
    #   ./fotocrypt.sh export [zielordner] [weitere Optionen, z. B. --email du@example.org --recovery --verify]
    OUT="${2:-$HOME/Desktop/fotocrypt-export}"; [ $# -ge 2 ] && shift 2 || shift 1
    case "$(uname -m)" in arm64) TOOL=tools/fotocrypt-decrypt-mac-arm64 ;; *) TOOL=tools/fotocrypt-decrypt-mac-intel ;; esac
    "$TOOL" --out "$OUT" "$@" data
    ;;
  list)    case "$(uname -m)" in arm64) tools/fotocrypt-decrypt-mac-arm64 --list data ;; *) tools/fotocrypt-decrypt-mac-intel --list data ;; esac ;;
  restore)
    FILE="${2:-}"; [ -f "$FILE" ] || { echo "usage: ./fotocrypt.sh restore backups/fotocrypt-....tar --yes" >&2; exit 2; }
    [ "${3:-}" = "--yes" ] || { echo "Das ERSETZT alle Daten in ./data durch die Sicherung. Mit --yes bestaetigen." >&2; exit 2; }
    # die Listen in einem eigenen, privaten Ordner (nicht unter festen Namen im gemeinsamen /tmp)
    L="$(mktemp -d)"; trap 'rm -rf "$L"' EXIT
    tar -tf "$FILE" > "$L/names"; tar -tvf "$FILE" > "$L/long"
    grep -qx "backup/app.db" "$L/names" && grep -qx "backup/secret" "$L/names" || { echo "Das Archiv hat kein backup/app.db oder backup/secret" >&2; exit 1; }
    if grep -E '^/|(^|/)\.\.(/|$)' "$L/names" >/dev/null; then echo "Archiv enthaelt unsichere Pfade" >&2; exit 1; fi
    if grep -v '^[-d]' "$L/long" >/dev/null || grep -E ' (->|link to) ' "$L/long" >/dev/null; then echo "Archiv enthaelt Links oder Geraete" >&2; exit 1; fi
    if grep -Ev '^(backup|blobs)(/|$)' "$L/names" >/dev/null; then echo "Archiv hat unerwartete Eintraege" >&2; exit 1; fi
    docker compose stop app >/dev/null
    # privat entpacken (wie die eigenen Ordner des Servers) und danach pruefen, was wirklich ausgepackt wurde: das
    # Archiv kann sich seit der Liste oben geaendert haben (z. B. auf einem geteilten oder externen Laufwerk)
    umask 077
    TS="$(date +%Y%m%d-%H%M%S)"; rm -rf .restore-tmp && mkdir .restore-tmp && tar -xf "$FILE" --no-same-owner -C .restore-tmp
    if [ -n "$(find .restore-tmp \( ! -type f ! -type d \) -o \( -type f -links +1 \) | head -1)" ] || [ -n "$(find .restore-tmp -mindepth 1 -maxdepth 1 ! -name backup ! -name blobs | head -1)" ] \
      || [ ! -f .restore-tmp/backup/app.db ] || [ ! -f .restore-tmp/backup/secret ]; then
      rm -rf .restore-tmp; docker compose start app >/dev/null; echo "Archiv hat sich beim Entpacken als unsicher erwiesen; nichts ersetzt" >&2; exit 1
    fi
    mv data "data.vorher-$TS"; mkdir data data/.previous
    # die ersetzte Datenbank dorthin, wo after-restore sie sucht: spaetere Abmeldungen, Passwoerter und gesperrte Konten bleiben
    for f in app.db app.db-wal app.db-shm secret; do [ ! -e "data.vorher-$TS/$f" ] || cp -p "data.vorher-$TS/$f" data/.previous/; done
    if [ -d .restore-tmp/blobs ]; then mv .restore-tmp/blobs data/blobs; fi; mv .restore-tmp/backup/app.db data/app.db; mv .restore-tmp/backup/secret data/secret; rm -rf .restore-tmp
    # vor dem Start: alle Sitzungen beenden, Spaeteres uebernehmen und dem Papierkorb der Sicherung frische 30 Tage geben
    docker compose run --rm --no-deps -T app after-restore
    rm -rf data/.previous
    docker compose up -d app; sleep 3
    docker compose exec -T app /app check
    echo "Fertig. Die alten Daten liegen noch in data.vorher-$TS (loeschen, wenn alles stimmt)."
    ;;
  update)
    # Rebuild the app from the source folder (default: ../Crypt) and restart it. Your data stays.
    SRC="${2:-$HOME/Desktop/Crypt}"
    [ -f "$SRC/Dockerfile" ] || { echo "Quellordner nicht gefunden: $SRC (./fotocrypt.sh update /pfad/zu/Crypt)" >&2; exit 2; }
    ./fotocrypt.sh backup
    docker build --build-arg VERSION="$(git -C "$SRC" describe --tags --abbrev=0 2>/dev/null | sed s/^v// || true)" -t fotocrypt:local "$SRC"
    docker compose up -d
    docker save fotocrypt:local | gzip > image/fotocrypt-image.tar.gz
    echo "aktualisiert: $URL"
    ;;
  *) cat <<H
./fotocrypt.sh  start | stop | restart | status | logs | open | token | backup | export [ziel] | list | restore <tar> --yes | update [quellordner]
H
  ;;
esac
