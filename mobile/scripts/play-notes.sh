#!/bin/sh
# Release notes for Google Play ("What's new", at most 500 characters per language), one file per language in OUT:
# en-US.txt and de-DE.txt. Each comes from docs/play/listing/<lang>/changelogs/<versionCode>.txt when that exists
# (short, written for people using the app). Without it, English falls back to the Android lines of the version's
# CHANGELOG.md section, cut to 500 characters, and German is left out (Play then shows the English notes).
#   mobile/scripts/play-notes.sh 2.1.1 dist/play-notes
set -eu
v="${1:?usage: $0 VERSION OUTDIR}"; v="${v#v}"
out="${2:?usage: $0 VERSION OUTDIR}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
export LC_ALL=C.UTF-8 2>/dev/null || true
case "$v" in *-*) echo "pre-release $v: Google Play gets only final releases" >&2; exit 1 ;; esac
IFS=. read -r major minor patch <<EOF
$v
EOF
vc=$((major * 1000000 + minor * 1000 + patch))  # as mobile/app.config.js
mkdir -p "$out"

for lang in en-US de-DE; do
  f="$root/docs/play/listing/$lang/changelogs/$vc.txt"
  if [ -f "$f" ]; then
    cp "$f" "$out/$lang.txt"
    n=$(wc -m < "$out/$lang.txt" | tr -d ' ')
    [ "$n" -le 500 ] || { echo "$f has $n characters, Google Play takes at most 500" >&2; exit 1; }
    echo "$lang: $f"
  elif [ "$lang" = en-US ]; then
    # the version's section, bullets joined with their continuation lines, only those for Android, without markdown
    awk -v v="$v" '
      $0 ~ "^## \\["v"\\]" { on = 1; next }
      on && /^## \[/ { exit }
      !on { next }
      /^- / { if (b != "") print b; b = substr($0, 3); next }
      /^  [^ ]/ && b != "" { sub(/^ +/, ""); b = b " " $0; next }
      { if (b != "") print b; b = "" }
      END { if (b != "") print b }
    ' "$root/CHANGELOG.md" \
      | grep '^Android' | sed -e 's/^Android[^:]*: //' -e 's/\*\*//g' -e 's/`//g' -e 's/\[\([^]]*\)\]([^)]*)/\1/g' \
      | awk '{ print "• " toupper(substr($0, 1, 1)) substr($0, 2) }' > "$out/$lang.txt.all" || true
    [ -s "$out/$lang.txt.all" ] || echo "• Fixes and improvements." > "$out/$lang.txt.all"
    # whole lines up to 500 characters, cut inside the first line only if that one alone is longer
    awk 'BEGIN { n = 0 } { l = length($0) + (NR > 1); if (n + l > 500) { if (NR == 1) print substr($0, 1, 499) "…"; exit } print; n += l }' \
      "$out/$lang.txt.all" > "$out/$lang.txt"
    rm "$out/$lang.txt.all"
    echo "$lang: from CHANGELOG.md (no docs/play/listing/$lang/changelogs/$vc.txt)"
  else
    echo "$lang: none (no docs/play/listing/$lang/changelogs/$vc.txt); Play shows the English notes"
  fi
done
