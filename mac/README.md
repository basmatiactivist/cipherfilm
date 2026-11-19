# Cipherfilm for macOS (source)

What the app does and how export, watched folders and search behave: [docs/MAC.md](../docs/MAC.md).

## Layout

- `Sources/CipherfilmCore`: everything that must match the other clients byte for byte: libsodium wrappers and the
  formats of docs/CRYPTO.md (`Sodium.swift`, `Crypto.swift`), the API and sign-in (`API.swift`), the library and
  uploads (`Library.swift`, `Upload.swift`), the WebDAV import's client, bookkeeping and ranged video reads
  (`WebDAV.swift`, `WebDAVImport.swift`, `RangedAsset.swift`), and search: ONNX Runtime (`ORT.swift`), the vision pipeline ported from
  Android's `Vision.kt` (`Vision.swift`), the CLIP tokenizer (`Tokenizer.swift`), the in-memory index and face
  grouping (`SearchIndex.swift`), models, index entries, the people document and the query words (`Search.swift`),
  the query parser ported from the web (`QueryParser.swift`), text in photos (`Ocr.swift`), the close-match cut
  (`Matches.swift`), On this day, trips and year recaps (`Memories.swift`, `Trips.swift`, `Recap.swift`), the
  archive and locked folder (`Folders.swift`), and administration and the storage overview (`Admin.swift`).
- `Sources/Cipherfilm`: the SwiftUI app (window, menu bar, Settings and its panes), the background work (`SearchEngine.swift`,
  `Exporter.swift`, `Watcher.swift`, `WebDAVImporter.swift`), the locked folder (`LockedFolder.swift`), video streaming
  (`VideoLoader.swift`) and a debug-only test driver (`DebugDriver.swift`, compiled out of release builds).
- `Tests/CipherfilmCoreTests`: the web client's test vectors, segment round trips, sealed formats, tokenizer ids,
  the index, the models, the query parser's shared cases, and a parity test against Android's entries on the test
  server. `Tests/CipherfilmAppTests`: what a lock and sign-out forget, the locked folder's split, the WebDAV import's
  state. `scripts/webdav-e2e.sh`
  runs the WebDAV import end to end against a throwaway server and reports disk, memory and throughput.

Dependencies, newest stable versions, pinned: libsodium 1.0.22 (swift-sodium 0.11.0) and ONNX Runtime 1.31.1 (Microsoft's
official NuGet package `Microsoft.ML.OnnxRuntime`, fetched by `scripts/fetch-onnxruntime.sh`, checked against its SHA-256
and against Microsoft's Apple Developer ID signature on the library; until 2.8.0 it came from the macOS release on
GitHub, which Microsoft took offline on 2026-11-17/18. Microsoft's Swift package lags behind, so it is not used).

## Build

With Xcode (newest):

```bash
(cd web && npm ci --ignore-scripts)   # MapLibre GL JS for the map, copied into the app by scripts/map-assets.sh
cd mac
./scripts/fetch-onnxruntime.sh
brew install xcodegen && xcodegen generate
xcodebuild -project Cipherfilm.xcodeproj -scheme CipherfilmApp -configuration Release build
```

With only the Command Line Tools (no Xcode): `./scripts/bundle.sh` builds `build/Cipherfilm.app` with SwiftPM and
signs it ad hoc. The macOS 27 SDK's SwiftUI needs a macro plugin that only Xcode has, so the script builds against the
newest macOS 26 SDK of the Command Line Tools there; the app runs on macOS 27 either way.

Tests: `./scripts/test.sh` (set `CF_MODELS=<folder with the five model files>` for the model tests, and
`CF_OCR_MODELS=<folder with the three text-in-photos files>` for the text test, or put them in the same folder).

`scripts/make-icon.swift` makes `AppIcon.icns` from `design/icon/icon-1024.png`.

## Testing against the throwaway server

Never the real server or library. Start `mobile/dev/compose.yaml` and create the test account with a password of your
own (`mobile/dev/account.mts` makes up a random one when `CF_TEST_PASSWORD` isn't set; then use the one it prints):

```bash
export CF_TEST_PASSWORD="$(openssl rand -base64 18)"   # the same shell for the account and the tests below
docker compose -f mobile/dev/compose.yaml exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > /tmp/cftest-ca.pem
(cd web && CF_CA=/tmp/cftest-ca.pem CF_SETUP_TOKEN=<token from: docker compose -f ../mobile/dev/compose.yaml logs app> \
  CF_TEST_PASSWORD="$CF_TEST_PASSWORD" npx tsx ../mobile/dev/account.mts)
cd mac && ./scripts/bundle.sh debug   # builds "Cipherfilm Dev", separate from a release build
CF_AUTOTEST=1 CF_TEST_CA=/tmp/cftest-ca.pem CF_TEST_SERVER=https://localhost:8443 \
  CF_TEST_EMAIL=tester@example.org CF_TEST_PASSWORD="$CF_TEST_PASSWORD" \
  CF_TEST_DIR=<scratch folder with an upload/ subfolder of test files> CF_SNAPSHOTS=<folder> \
  "build/Cipherfilm Dev.app/Contents/MacOS/Cipherfilm"
```

The debug build trusts the test CA only when `CF_TEST_CA` (or the `CFTestCA` default) is set; release builds trust the
system's certificates only. The driver signs in, uploads, opens photos and a video, uses favorites and albums, turns
on search and people, exports, and tests watched folders (also while locked), printing `CFTEST PASS/FAIL` lines.
It deletes everything it made in `CF_TEST_DIR` (an export there is a copy of the whole test library) at the start and
the end of a run, keeping only `upload/`; `CF_KEEP=1` keeps the last run's files. Keep `upload/` to a few small files.
With `CF_TEST_EXPLICIT=1` it also allows the test account explicit search (it is the test server's admin), turns it
on (search unfiltered, nothing indexed again), searches, and turns it off again (explicit words find nothing).
With `CF_LIVE_EXPECT=N` it prints `CFTEST LIVE READY` after the library loads and waits for N photos that another
device (for example `cipherfilm-upload`) uploads then to appear without a refresh. `CF_SIGNIN_ONLY=1` only signs in
and leaves the app open for trying it by hand; with `CF_SETTINGS_SHOTS=1` it first writes a picture of every Settings
pane into `CF_SNAPSHOTS`. `CF_MAP=1` runs only the map's checks.

LAION ViT-B/32 vectors against the Python reference (`pip install onnxruntime==1.31.1 numpy pillow`):

```bash
python3 scripts/laion-reference.py <models> /tmp/laion-ref.json <images…>
CF_MODELS=<models> CF_LAION_REF=/tmp/laion-ref.json ./scripts/test.sh --filter LaionParity
```

Android parity of the search vectors:

```bash
CF_TEST_SERVER=https://localhost:8443 CF_TEST_CA=/tmp/cftest-ca.pem CF_TEST_PASSWORD="$CF_TEST_PASSWORD" \
  CF_MODELS=<models> ./scripts/test.sh --filter AndroidParity
```
