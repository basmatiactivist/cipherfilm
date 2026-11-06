#!/bin/bash
# Google Play Developer API (Edits) for the release workflow, with nothing but curl, openssl and jq: the service
# account's key never leaves this process (no third-party action sees it). The key is the JSON in
# PLAY_SERVICE_ACCOUNT_JSON (docs/RELEASING.md, "Google Play from CI").
#   play.sh upload AAB TRACK NOTES_DIR     upload the bundle and release it on TRACK (internal, alpha, beta, production)
#                                          with NOTES_DIR/<lang>.txt as "What's new" (mobile/scripts/play-notes.sh)
#   play.sh promote VERSIONCODE FROM TO [FRACTION]
#                                          give the release of VERSIONCODE on track FROM, with its notes, to track TO;
#                                          FRACTION below 1 is a staged rollout (e.g. 0.2)
# While the app is still a draft in Play Console (nothing reviewed yet), Play takes only draft releases: the release
# is then created as a draft and has to be rolled out in Play Console once.
set -euo pipefail
PKG="${PLAY_PACKAGE:-app.cipherfilm}"
ROOT="${PLAY_API_ROOT:-https://androidpublisher.googleapis.com}"  # another one only for a test against a stand-in
API="$ROOT/androidpublisher/v3/applications/$PKG"
UPLOAD="$ROOT/upload/androidpublisher/v3/applications/$PKG"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
umask 077

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# an access token for the androidpublisher scope, from a JWT signed with the service account's key
token() {
  local email uri now claims unsigned sig
  : "${PLAY_SERVICE_ACCOUNT_JSON:?PLAY_SERVICE_ACCOUNT_JSON is not set}"
  email=$(jq -r .client_email <<<"$PLAY_SERVICE_ACCOUNT_JSON")
  uri=$(jq -r '.token_uri // "https://oauth2.googleapis.com/token"' <<<"$PLAY_SERVICE_ACCOUNT_JSON")
  jq -r .private_key <<<"$PLAY_SERVICE_ACCOUNT_JSON" > "$tmp/key.pem"
  now=$(date +%s)
  claims=$(jq -cn --arg iss "$email" --arg aud "$uri" --argjson iat "$now" \
    '{iss: $iss, scope: "https://www.googleapis.com/auth/androidpublisher", aud: $aud, iat: $iat, exp: ($iat + 900)}')
  unsigned="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '%s' "$claims" | b64url)"
  sig=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$tmp/key.pem" | b64url)
  rm "$tmp/key.pem"
  printf 'assertion=%s.%s&grant_type=urn%%3Aietf%%3Aparams%%3Aoauth%%3Agrant-type%%3Ajwt-bearer' "$unsigned" "$sig" > "$tmp/grant"
  curl -sS --fail-with-body --data @"$tmp/grant" "$uri" | jq -r .access_token > "$tmp/token"
  rm "$tmp/grant"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$(cat "$tmp/token")"
  # the token only in a header file, never on a command line
  printf 'Authorization: Bearer %s\n' "$(cat "$tmp/token")" > "$tmp/auth"
}

# api METHOD URL [curl args...]: the answer's body; the body of an error goes to stderr
api() {
  local m="$1" u="$2"; shift 2
  local out
  out=$(curl -sS --fail-with-body -X "$m" -H @"$tmp/auth" "$@" "$u") || { echo "$m $u: $out" >&2; return 1; }
  printf '%s' "$out"
}

notes_json() {
  local dir="$1" f out="[]"
  for f in "$dir"/*.txt; do
    [ -f "$f" ] || continue
    out=$(jq -c --arg l "$(basename "$f" .txt)" --rawfile t "$f" '. + [{language: $l, text: ($t | rtrimstr("\n"))}]' <<<"$out")
  done
  printf '%s' "$out"
}

# set_track EDIT TRACK RELEASE_JSON: a release that Play refuses because the app is still a draft becomes a draft
set_track() {
  local edit="$1" track="$2" rel="$3" body err
  body=$(jq -c --arg t "$track" '{track: $t, releases: [.]}' <<<"$rel")
  if ! api PUT "$API/edits/$edit/tracks/$track" -H 'Content-Type: application/json' --data "$body" 2>"$tmp/err" >/dev/null; then
    err=$(cat "$tmp/err")
    case "$err" in
      *"draft app"*)
        echo "the app is still a draft in Play Console: the release goes to $track as a draft (roll it out there once)"
        body=$(jq -c '.releases[0] |= (.status = "draft" | del(.userFraction))' <<<"$body")
        api PUT "$API/edits/$edit/tracks/$track" -H 'Content-Type: application/json' --data "$body" >/dev/null ;;
      *) echo "$err" >&2; return 1 ;;
    esac
  fi
}

release_json() {  # VERSIONCODE NAME NOTES_JSON FRACTION
  jq -cn --arg vc "$1" --arg name "$2" --argjson notes "$3" --arg f "$4" '
    {name: $name, versionCodes: [$vc], releaseNotes: $notes}
    + (if ($f | tonumber) < 1 then {status: "inProgress", userFraction: ($f | tonumber)} else {status: "completed"} end)
    | if (.releaseNotes | length) == 0 then del(.releaseNotes) else . end'
}

cmd="${1:-}"; shift || true
case "$cmd" in
  upload)
    aab="${1:?usage: $0 upload AAB TRACK NOTES_DIR}"; track="${2:?}"; notes="${3:?}"
    token
    edit=$(api POST "$API/edits" | jq -r .id)
    bundle=$(api POST "$UPLOAD/edits/$edit/bundles?uploadType=media" -H 'Content-Type: application/octet-stream' \
      --data-binary @"$aab" --max-time 1800)
    vc=$(jq -r .versionCode <<<"$bundle")
    [ "$(jq -r .sha256 <<<"$bundle")" = "$(sha256sum "$aab" | cut -d' ' -f1)" ] \
      || { echo "Play holds another bundle than $aab: $bundle" >&2; exit 1; }
    name=$(basename "$aab" .aab); name="${name#cipherfilm-play-}"
    set_track "$edit" "$track" "$(release_json "$vc" "$name" "$(notes_json "$notes")" 1)"
    api POST "$API/edits/$edit:commit" >/dev/null
    echo "versionCode $vc ($name) is on the $track track" ;;
  promote)
    vc="${1:?usage: $0 promote VERSIONCODE FROM TO [FRACTION]}"; from="${2:?}"; to="${3:?}"; fraction="${4:-1}"
    token
    edit=$(api POST "$API/edits" | jq -r .id)
    src=$(api GET "$API/edits/$edit/tracks/$from" | jq -c --arg vc "$vc" '[.releases[]? | select(.versionCodes | index($vc))][0]')
    [ "$src" != null ] || { echo "versionCode $vc is not on the $from track" >&2; exit 1; }
    set_track "$edit" "$to" "$(release_json "$vc" "$(jq -r .name <<<"$src")" "$(jq -c '.releaseNotes // []' <<<"$src")" "$fraction")"
    api POST "$API/edits/$edit:commit" >/dev/null
    echo "versionCode $vc went from $from to $to (fraction $fraction)" ;;
  *) sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
