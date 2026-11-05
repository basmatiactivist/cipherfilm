#!/bin/sh
# Builds Cipherfilm.app with SwiftPM, for Macs that have only the Command Line Tools (with Xcode, use project.yml and
# xcodebuild, see README.md). Output: build/Cipherfilm.app, signed ad hoc (or with $SIGN_IDENTITY).
#   scripts/bundle.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."
CONF=${1:-release}
./scripts/fetch-onnxruntime.sh
# The macOS 27 SDK's SwiftUI needs a macro plugin that ships with Xcode only; the Command Line Tools' 26.x SDK doesn't.
if [ -z "${SDKROOT:-}" ] && ! xcodebuild -version >/dev/null 2>&1; then
  for s in $(ls -d "$(xcode-select -p)"/SDKs/MacOSX26*.sdk 2>/dev/null | sort -r); do SDKROOT=$s; break; done
  export SDKROOT
fi
# no build machine paths in the binary (they name the person who built it): the repository becomes ".", the home
# folder "~". scripts/check-artifacts.sh checks this before anything is uploaded.
ROOT=$(cd .. && pwd -P)
MAP="-Xswiftc -file-prefix-map -Xswiftc $ROOT=. -Xswiftc -file-prefix-map -Xswiftc $HOME=~ -Xcc -ffile-prefix-map=$ROOT=. -Xcc -ffile-prefix-map=$HOME=~"
swift build -c "$CONF" --product Cipherfilm $MAP
BIN=$(swift build -c "$CONF" --show-bin-path $MAP)
# a debug build is a separate app ("Cipherfilm Dev", its own bundle id, settings, cookies and folders), so testing it
# never touches the account a release build on the same Mac is signed in to
if [ "$CONF" = "debug" ]; then APP="build/Cipherfilm Dev.app"; else APP="build/Cipherfilm.app"; fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$BIN/Cipherfilm" "$APP/Contents/MacOS/Cipherfilm"
# the linker's debug map still names every object file by its full build path; a release needs none of it
[ "$CONF" = "debug" ] || strip -S "$APP/Contents/MacOS/Cipherfilm"
cp Sources/Cipherfilm/Info.plist "$APP/Contents/Info.plist"
# the version (Xcode fills these from MARKETING_VERSION / CURRENT_PROJECT_VERSION; SwiftPM doesn't): $VERSION, else
# the newest tag
V=${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo 0.0.0)}; V=${V#v}
plutil -replace CFBundleShortVersionString -string "${V%%-*}" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}" "$APP/Contents/Info.plist"
if [ "$CONF" = "debug" ]; then
  plutil -replace CFBundleIdentifier -string app.cipherfilm.mac.dev "$APP/Contents/Info.plist"
  plutil -replace CFBundleName -string "Cipherfilm Dev" "$APP/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "Cipherfilm Dev" "$APP/Contents/Info.plist"
fi
cp Sources/Cipherfilm/Resources/AppIcon.icns "$APP/Contents/Resources/"
FW=$(find "$BIN" -maxdepth 3 -name onnxruntime.framework -type d | head -1)
[ -n "$FW" ] || FW=Vendor/onnxruntime.xcframework/macos-arm64/onnxruntime.framework
cp -R "$FW" "$APP/Contents/Frameworks/"
install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/Cipherfilm" 2>/dev/null || true
ID=${SIGN_IDENTITY:--}
codesign --force --sign "$ID" --timestamp=none "$APP/Contents/Frameworks/onnxruntime.framework"
# always with the hardened runtime; the entitlements turn off only its library validation, which would refuse the
# embedded framework of an ad-hoc signature (no team)
codesign --force --sign "$ID" --timestamp=none --options runtime --entitlements Sources/Cipherfilm/Cipherfilm.entitlements "$APP"
echo "built $APP"
