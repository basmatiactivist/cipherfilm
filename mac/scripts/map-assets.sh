#!/bin/sh
# Copies what the map needs into the app's Resources folder (MapPage.swift serves it to its web view): the page
# (Sources/Cipherfilm/Resources/map), MapLibre GL JS from web/node_modules in exactly the version web/package.json pins
# (installed with `npm ci --ignore-scripts` in web/, checked against package-lock.json's hashes; no copy of it is kept
# in the repository), and the place names (web/src/places/places-v1.bin, GeoNames, CC BY 4.0).
#   scripts/map-assets.sh <the app's Contents/Resources>
# bundle.sh and the Xcode project (project.yml) run it.
set -eu
cd "$(dirname "$0")/.."
DEST=${1:?usage: map-assets.sh <Resources folder>}
WEB=../web
ML=$WEB/node_modules/maplibre-gl
want=$(sed -n 's/^ *"maplibre-gl": *"\([^"]*\)".*/\1/p' "$WEB/package.json")
have=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$ML/package.json" 2>/dev/null || true)
if [ -z "$want" ] || [ "$have" != "$want" ]; then
  echo "map-assets: MapLibre GL JS $want is needed (found: ${have:-none}); run: (cd web && npm ci --ignore-scripts)" >&2
  exit 1
fi
mkdir -p "$DEST/map"
cp Sources/Cipherfilm/Resources/map/map.html Sources/Cipherfilm/Resources/map/map.js Sources/Cipherfilm/Resources/map/map.css "$DEST/map/"
cp "$ML/dist/maplibre-gl.mjs" "$ML/dist/maplibre-gl-worker.mjs" "$ML/dist/maplibre-gl.css" "$DEST/map/"
# its licence (BSD-3-Clause) travels with it
cp "$ML/LICENSE.txt" "$DEST/map/maplibre-gl-LICENSE.txt"
cp "$WEB/src/places/places-v1.bin" "$DEST/"
