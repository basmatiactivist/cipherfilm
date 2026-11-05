#!/bin/sh
# Runs the core tests. With only the Command Line Tools installed, SwiftPM doesn't find the Swift Testing macros by
# itself; the plugin path below is where they live there. CF_MODELS=<folder with the model files> runs the model tests.
set -eu
cd "$(dirname "$0")/.."
./scripts/fetch-onnxruntime.sh
# without Xcode, the newest macOS 26 SDK (see bundle.sh)
if [ -z "${SDKROOT:-}" ] && ! xcodebuild -version >/dev/null 2>&1; then
  for s in $(ls -d "$(xcode-select -p)"/SDKs/MacOSX26*.sdk 2>/dev/null | sort -r); do SDKROOT=$s; break; done
  export SDKROOT
fi
DEV=$(xcode-select -p)
PLUG="$DEV/usr/lib/swift/host/plugins/testing"
[ -d "$PLUG" ] || PLUG="$DEV/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing"
if [ -d "$PLUG" ]; then exec swift test -Xswiftc -plugin-path -Xswiftc "$PLUG" "$@"; else exec swift test "$@"; fi
