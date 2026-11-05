#!/bin/sh
# Checks an APK or AAB for 16 KB memory pages (Google Play, docs/play/REQUIREMENTS.md §1.4): every 64-bit native
# library must have its ELF LOAD segments aligned to 16 KB (2**14), and an APK's uncompressed libraries must be
# zip-aligned to 16 KB (zipalign -P 16; with useLegacyPackaging they are compressed, so this only catches a change).
#   ANDROID_NDK_HOME=... [ZIPALIGN=.../build-tools/X/zipalign] mobile/scripts/check-page-size.sh app.apk|app.aab ...
set -eu
[ $# -gt 0 ] || { echo "usage: $0 FILE.apk|FILE.aab ..." >&2; exit 2; }
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the NDK directory (for llvm-readelf)}"
READELF="$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-readelf)"
[ -x "$READELF" ] || { echo "no llvm-readelf in $ANDROID_NDK_HOME" >&2; exit 2; }
tmp=$(mktemp -d /tmp/cfpage.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
bad=0
for f in "$@"; do
  d="$tmp/$(basename "$f")"; mkdir -p "$d"
  unzip -q -o "$f" '*.so' -d "$d" 2>/dev/null || true
  n=0
  for so in $(find "$d" -name '*.so' | sort); do
    case "$so" in */armeabi-v7a/*|*/x86/*) continue ;; esac  # 32-bit: 4 KB pages only
    n=$((n + 1))
    for a in $("$READELF" -lW "$so" | awk '$1 == "LOAD" { print $NF }'); do
      if [ $((a)) -lt 16384 ]; then echo "NOT 16 KB ALIGNED ($a): ${so#"$d"/}"; bad=1; break; fi
    done
  done
  [ "$n" -gt 0 ] || { echo "no 64-bit native libraries found in $f" >&2; bad=1; }
  case "$f" in
    *.apk)
      if [ -n "${ZIPALIGN:-}" ]; then
        "$ZIPALIGN" -c -P 16 -v 4 "$f" >"$tmp/zipalign.log" 2>&1 || { echo "zipalign -c -P 16 failed for $f:"; grep -v "(OK" "$tmp/zipalign.log" | tail -20; bad=1; }
      else
        echo "ZIPALIGN not set: zip alignment of $f not checked" >&2
      fi ;;
  esac
  echo "$f: $n 64-bit native libraries checked"
done
[ $bad -eq 0 ] && echo "16 KB page size: OK" && exit 0
exit 1
