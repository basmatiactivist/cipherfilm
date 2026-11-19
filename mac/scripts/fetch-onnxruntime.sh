#!/bin/sh
# Fetches Microsoft's ONNX Runtime for macOS (Apple silicon) from its official NuGet package (Microsoft.ML.OnnxRuntime
# on nuget.org), checks the package's SHA-256 and that the library carries Microsoft's Apple Developer ID signature, and
# wraps it as Vendor/onnxruntime.xcframework, which Package.swift and project.yml use. The release is pinned: to update,
# change VERSION and SHA256 to the values of microsoft.ml.onnxruntime.<version>.nupkg.
# Until 2.8.0 this came from the macOS release on github.com/microsoft/onnxruntime; Microsoft took that repository off
# GitHub on 2026-11-17/18, so the NuGet package (the same version, Microsoft's own build of it) is used instead.
set -eu
VERSION=1.31.1
SHA256=6871ccbc97f3d5bdb4095a1dcec33aa78d56f6ed8de5980ef5fa1d9f2e7c679a
MARK="$VERSION nuget"
cd "$(dirname "$0")/.."
OUT=Vendor/onnxruntime.xcframework
if [ -f "$OUT/.version" ] && [ "$(cat "$OUT/.version")" = "$MARK" ]; then exit 0; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/ort.nupkg" "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$VERSION/microsoft.ml.onnxruntime.$VERSION.nupkg"
echo "$SHA256  $WORK/ort.nupkg" | shasum -a 256 -c - >/dev/null
SRC="$WORK/pkg"
unzip -q "$WORK/ort.nupkg" 'runtimes/osx-arm64/native/*' 'build/native/include/*' LICENSE ThirdPartyNotices.txt -d "$SRC"
LIB="$SRC/runtimes/osx-arm64/native/libonnxruntime.dylib"
# signed by Microsoft (Apple Developer ID, team UBF8T346G9), checked before our own ad-hoc signature replaces it
codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "UBF8T346G9"' "$LIB"

# a versioned macOS framework around the dylib, so Xcode and SwiftPM embed and sign it like any other
FW="$WORK/onnxruntime.framework"
mkdir -p "$FW/Versions/A/Headers" "$FW/Versions/A/Modules" "$FW/Versions/A/Resources"
cp "$LIB" "$FW/Versions/A/onnxruntime"
install_name_tool -id @rpath/onnxruntime.framework/Versions/A/onnxruntime "$FW/Versions/A/onnxruntime" 2>/dev/null
for h in onnxruntime_c_api.h onnxruntime_ep_c_api.h onnxruntime_error_code.h; do  # the package's headers have CRLF line ends
  tr -d '\r' < "$SRC/build/native/include/$h" > "$FW/Versions/A/Headers/$h"
done
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
echo "$MARK" > "$OUT/.version"
echo "ONNX Runtime $VERSION -> $OUT"
