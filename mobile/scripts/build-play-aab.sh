#!/bin/sh
# Builds the Google Play App Bundle locally, as the release workflow does (android.yml): CF_STORE=play, arm64, signed
# with the upload key (alias "upload"), then checks 16 KB pages and that no build path or name is in it. For the first
# upload to Play Console, before a release built it. `make play-aab VERSION=X.Y.Z` runs it.
#   VERSION=2.1.0 mobile/scripts/build-play-aab.sh
# Needs: ANDROID_HOME (default ~/Library/Android/sdk), the NDK in $ANDROID_HOME/ndk/$NDK, minisign (libsodium), and
# the upload key in $CF_SIGNING_DIR (default ~/.cipherfilm-android-signing): upload.p12 and upload-password.txt.
# Build from a worktree outside the home folder, with GRADLE_USER_HOME outside it too (docs/RELEASING.md): native
# libraries keep build paths, and scripts/check-artifacts.sh refuses a bundle that names the home folder.
set -eu
: "${VERSION:?set VERSION, e.g. VERSION=2.1.0}"
VERSION="${VERSION#v}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="${NDK:-30.0.16248370}"
SIGNING="${CF_SIGNING_DIR:-$HOME/.cipherfilm-android-signing}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$ROOT/dist}"
export ANDROID_HOME GRADLE_USER_HOME="${GRADLE_USER_HOME:-/tmp/cf-gradle}"

case "$ROOT" in "$HOME"/*) echo "warning: $ROOT is inside the home folder; the bundle will likely fail the artifact check" >&2 ;; esac
[ -f "$SIGNING/upload.p12" ] && [ -f "$SIGNING/upload-password.txt" ] || { echo "no upload key in $SIGNING" >&2; exit 1; }
[ -d "$ANDROID_HOME/ndk/$NDK" ] || { echo "NDK $NDK not found in $ANDROID_HOME/ndk" >&2; exit 1; }

cd "$ROOT/mobile"
[ -f modules/cf-native/android/src/main/jniLibs/arm64-v8a/libsodium.so ] \
  || ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK" modules/cf-native/scripts/build-libsodium.sh
[ -d node_modules ] || npm ci
CF_STORE=play CF_VERSION="$VERSION" npx expo prebuild --platform android --clean --no-install

# the password only in this process's environment, never on the command line or in a file Gradle writes
CF_KEYSTORE_PASSWORD="$(cat "$SIGNING/upload-password.txt")"
export CF_KEYSTORE_PASSWORD
(cd android && CF_STORE=play CF_VERSION="$VERSION" CF_KEYSTORE="$SIGNING/upload.p12" CF_KEY_ALIAS=upload \
  ./gradlew bundleRelease -PreactNativeArchitectures=arm64-v8a --console=plain)
unset CF_KEYSTORE_PASSWORD
"$ROOT/mobile/scripts/check-play-manifest.sh" android/app

mkdir -p "$OUT"
AAB="$OUT/cipherfilm-play-$VERSION.aab"
cp android/app/build/outputs/bundle/release/app-release.aab "$AAB"
echo "signed by:"; keytool -printcert -jarfile "$AAB" | grep -E "Owner:|SHA256:"
ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK" "$ROOT/mobile/scripts/check-page-size.sh" "$AAB"
"$ROOT/scripts/check-artifacts.sh" "$AAB"
echo "$AAB"
