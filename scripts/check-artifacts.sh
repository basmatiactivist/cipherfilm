#!/bin/sh
# Checks release files before they are uploaded: none may contain a path of the machine that built them (the home
# folder, and so the user name) or the builder's name. Archives (.zip, .apk, .aab) are unpacked and searched inside.
#   scripts/check-artifacts.sh dist/*
# Exit 1 with the matches if anything is found. Extra words to look for: CHECK_ARTIFACTS_EXTRA="word1|word2".
set -eu
[ $# -gt 0 ] || { echo "usage: $0 FILE..." >&2; exit 2; }
# the user name also with "-" or "_" for "." (as in a temporary folder named after the home folder)
user=$(id -un | sed 's/[-._]/[-._]/g')
pat="$HOME|/Users/$user|/home/$user|$user"
[ -n "${CHECK_ARTIFACTS_EXTRA:-}" ] && pat="$pat|$CHECK_ARTIFACTS_EXTRA"
# CHECK_ARTIFACTS_ONLY_EXTRA=1: look only for the extra words (the Play bundle keeps unstripped libraries and debug
# symbols, which name the CI machine's build folder; that names nobody, so there only a person's home is looked for)
[ "${CHECK_ARTIFACTS_ONLY_EXTRA:-}" = 1 ] && pat="${CHECK_ARTIFACTS_EXTRA:?CHECK_ARTIFACTS_ONLY_EXTRA needs CHECK_ARTIFACTS_EXTRA}"
tmp=$(mktemp -d /tmp/cfcheck.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
bad=0
n=0
for f in "$@"; do
  # every argument must be a file that can be searched: a folder, a link or a pattern that matched nothing is an error
  if [ -L "$f" ] || [ ! -f "$f" ]; then
    echo "NOT A REGULAR FILE: $f" >&2; bad=1; continue
  fi
  case "$f" in
    *.zip|*.apk|*.aab)
      d="$tmp/$(basename "$f")"; mkdir -p "$d"; unzip -q -o "$f" -d "$d"
      hits=$(LC_ALL=C grep -rlaE "$pat" "$d" 2>/dev/null | sed "s|$d/||" || true) ;;
    *) hits=$(LC_ALL=C grep -laE "$pat" "$f" 2>/dev/null || true) ;;
  esac
  n=$((n + 1))
  if [ -n "$hits" ]; then
    bad=1
    echo "FOUND in $f:"; echo "$hits" | sed 's/^/  /' | head -20
  fi
done
[ $bad -eq 0 ] && [ $n -eq $# ] && echo "artifacts clean: no build paths or user name in $n files" && exit 0
exit 1
