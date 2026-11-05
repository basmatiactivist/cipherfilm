#!/bin/sh
# Builds libsodium for the Android app from the signed release: download, check the author's minisign signature and
# the pinned hash, compile with the NDK, and place libsodium.so per ABI in android/src/main/jniLibs/ (not committed).
#   ANDROID_NDK_HOME=~/Library/Android/sdk/ndk/<version> modules/cf-native/scripts/build-libsodium.sh
set -eu
VERSION=1.0.22
SHA256=adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349
PUBKEY=RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3   # libsodium's release key (libsodium.org docs)
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the NDK directory}"
command -v minisign >/dev/null || { echo "minisign is needed (brew install minisign)" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/android/src/main/jniLibs"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
curl -sSfO "https://download.libsodium.org/libsodium/releases/libsodium-$VERSION.tar.gz"
curl -sSfO "https://download.libsodium.org/libsodium/releases/libsodium-$VERSION.tar.gz.minisig"
minisign -Vqm "libsodium-$VERSION.tar.gz" -P "$PUBKEY"
echo "$SHA256  libsodium-$VERSION.tar.gz" | shasum -a 256 -c - >/dev/null
tar -xzf "libsodium-$VERSION.tar.gz"
cd "libsodium-$VERSION"
# NDK_PLATFORM: the app's minSdk. The NDK's archiver, not the Mac's: with the host `ar` the ARM-specific parts
# (Argon2's NEON code, the ARM crypto extensions) silently drop out of libsodium.so.
TOOLS="$(echo "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin)"
export NDK_PLATFORM=android-24 LIBSODIUM_FULL_BUILD=1 AR="$TOOLS/llvm-ar" RANLIB="$TOOLS/llvm-ranlib" NM="$TOOLS/llvm-nm"
# arm64-v8a: every current phone, and the emulator on Apple silicon
sh dist-build/android-armv8-a.sh >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log" >&2; exit 1; }
mkdir -p "$OUT/arm64-v8a"
LIB=libsodium-android-armv8-a+crypto/lib/libsodium.so
# every symbol the library needs from itself must be in it
if "$NM" -D --undefined-only "$LIB" | grep -v "@" | grep -q .; then
  echo "libsodium.so has unresolved internal symbols:" >&2; "$NM" -D --undefined-only "$LIB" | grep -v "@" >&2; exit 1
fi
# Google Play needs 16 KB pages on 64-bit (docs/play/REQUIREMENTS.md §1.4): every LOAD segment aligned to 2**14
if ! "$TOOLS/llvm-readelf" -lW "$LIB" | awk '$1 == "LOAD" { print $NF }' | { while read -r a; do [ $((a)) -ge 16384 ] || exit 1; done; }; then
  echo "libsodium.so is not 16 KB aligned:" >&2; "$TOOLS/llvm-readelf" -lW "$LIB" | grep LOAD >&2; exit 1
fi
cp "$LIB" "$OUT/arm64-v8a/libsodium.so"
echo "libsodium $VERSION built for: $(ls "$OUT" | tr '\n' ' ')"
