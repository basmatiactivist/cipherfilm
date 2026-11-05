#!/bin/sh
# Fetches Microsoft's ONNX Runtime release for macOS (Apple silicon), checks its SHA-256 and wraps the library as
# Vendor/onnxruntime.xcframework, which Package.swift and project.yml use. The release is pinned: to update, change
# VERSION and SHA256 to the values GitHub shows for onnxruntime-osx-arm64-<version>.tgz.
set -eu
VERSION=1.31.1
SHA256=2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f
cd "$(dirname "$0")/.."
OUT=Vendor/onnxruntime.xcframework
if [ -f "$OUT/.version" ] && [ "$(cat "$OUT/.version")" = "$VERSION" ]; then exit 0; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/ort.tgz" "https://github.com/microsoft/onnxruntime/releases/download/v$VERSION/onnxruntime-osx-arm64-$VERSION.tgz"
echo "$SHA256  $WORK/ort.tgz" | shasum -a 256 -c - >/dev/null
tar -xzf "$WORK/ort.tgz" -C "$WORK"
SRC="$WORK/onnxruntime-osx-arm64-$VERSION"

# a versioned macOS framework around the dylib, so Xcode and SwiftPM embed and sign it like any other
FW="$WORK/onnxruntime.framework"
mkdir -p "$FW/Versions/A/Headers" "$FW/Versions/A/Modules" "$FW/Versions/A/Resources"
cp "$SRC/lib/libonnxruntime.$VERSION.dylib" "$FW/Versions/A/onnxruntime"
install_name_tool -id @rpath/onnxruntime.framework/Versions/A/onnxruntime "$FW/Versions/A/onnxruntime" 2>/dev/null
cp "$SRC"/include/onnxruntime_c_api.h "$SRC"/include/onnxruntime_ep_c_api.h "$SRC"/include/onnxruntime_error_code.h "$FW/Versions/A/Headers/" 2>/dev/null || cp "$SRC"/include/onnxruntime_c_api.h "$FW/Versions/A/Headers/"
cat > "$FW/Versions/A/Modules/module.modulemap" <<'MAP'
framework module onnxruntime {
  header "onnxruntime_c_api.h"
  link "onnxruntime"
  export *
}
MAP
cat > "$FW/Versions/A/Resources/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>onnxruntime</string>
  <key>CFBundleIdentifier</key><string>com.microsoft.onnxruntime</string>
  <key>CFBundleName</key><string>onnxruntime</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>MinimumOSVersion</key><string>14.0</string>
</dict></plist>
PLIST
cp "$SRC/LICENSE" "$FW/Versions/A/Resources/LICENSE"
cp "$SRC/ThirdPartyNotices.txt" "$FW/Versions/A/Resources/ThirdPartyNotices.txt"
ln -s A "$FW/Versions/Current"
for x in onnxruntime Headers Modules Resources; do ln -s "Versions/Current/$x" "$FW/$x"; done
codesign --force --sign - "$FW" >/dev/null 2>&1

rm -rf "$OUT"
mkdir -p Vendor
xcodebuild -create-xcframework -framework "$FW" -output "$OUT" >/dev/null 2>&1 || {
  # without Xcode (Command Line Tools only): the same layout by hand
  mkdir -p "$OUT/macos-arm64"
  cp -R "$FW" "$OUT/macos-arm64/"
  cat > "$OUT/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AvailableLibraries</key><array><dict>
    <key>BinaryPath</key><string>onnxruntime.framework/Versions/A/onnxruntime</string>
    <key>LibraryIdentifier</key><string>macos-arm64</string>
    <key>LibraryPath</key><string>onnxruntime.framework</string>
    <key>SupportedArchitectures</key><array><string>arm64</string></array>
    <key>SupportedPlatform</key><string>macos</string>
  </dict></array>
  <key>CFBundlePackageType</key><string>XFWK</string>
  <key>XCFrameworkFormatVersion</key><string>1.0</string>
</dict></plist>
PLIST
}
echo "$VERSION" > "$OUT/.version"
echo "ONNX Runtime $VERSION -> $OUT"
