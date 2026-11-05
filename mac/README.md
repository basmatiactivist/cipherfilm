# Cipherfilm for macOS (source)

What the app does and how export, watched folders and search behave: [docs/MAC.md](../docs/MAC.md).

## Layout

- `Sources/CipherfilmCore`: everything that must match the other clients byte for byte: libsodium wrappers and the
  formats of docs/CRYPTO.md (`Sodium.swift`, `Crypto.swift`), the API and sign-in (`API.swift`), the library and
  uploads (`Library.swift`, `Upload.swift`), and search: ONNX Runtime (`ORT.swift`), the vision pipeline ported from
  Android's `Vision.kt` (`Vision.swift`), the CLIP tokenizer (`Tokenizer.swift`), the in-memory index and face
  grouping (`SearchIndex.swift`), models, index entries, the people document and the query words (`Search.swift`).
- `Sources/Cipherfilm`: the SwiftUI app (window, menu bar, Settings), the background work (`SearchEngine.swift`,
  `Exporter.swift`, `Watcher.swift`), video streaming (`VideoLoader.swift`) and a debug-only test driver
  (`DebugDriver.swift`, compiled out of release builds).
- `Tests/CipherfilmCoreTests`: the web client's test vectors, segment round trips, sealed formats, tokenizer ids,
  the index, the models, and a parity test against Android's entries on the test server.

Dependencies, newest stable versions, pinned: libsodium 1.0.22 (swift-sodium 0.11.0) and ONNX Runtime 1.31.1 (the
official macOS release, fetched by `scripts/fetch-onnxruntime.sh` and checked against its SHA-256; Microsoft's Swift
package lags behind, so it is not used).

## Build

With Xcode (newest):

```bash
cd mac
./scripts/fetch-onnxruntime.sh
brew install xcodegen && xcodegen generate
xcodebuild -project Cipherfilm.xcodeproj -scheme CipherfilmApp -configuration Release build
```

With only the Command Line Tools (no Xcode): `./scripts/bundle.sh` builds `build/Cipherfilm.app` with SwiftPM and
signs it ad hoc. The macOS 27 SDK's SwiftUI needs a macro plugin that only Xcode has, so the script builds against the
newest macOS 26 SDK of the Command Line Tools there; the app runs on macOS 27 either way.

Tests: `./scripts/test.sh` (set `CF_MODELS=<folder with the five model files>` for the model tests).

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
on, waits for the LAION index, searches, and turns it off again.

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
