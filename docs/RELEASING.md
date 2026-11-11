# Releasing

Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **PATCH** (1.0.1): bug and security fixes, dependency updates, no changes to stored data.
- **MINOR** (1.1.0): new features; database changes are applied automatically and are backward compatible.
- **MAJOR** (2.0.0): anything that needs action from the operator or changes the encrypted format.
  The crypto format version is part of `docs/CRYPTO.md`; a format change is always a major release.

## Cutting a release

1. Move the entries from `## [Unreleased]` in `CHANGELOG.md` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
   For Google Play, also write the short "What's new" in `docs/play/listing/en-US/changelogs/<versionCode>.txt` and
   `docs/play/listing/de-DE/changelogs/<versionCode>.txt` ("Google Play from CI" below).
2. Commit that on `master` and wait for CI to pass.
3. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m "Cipherfilm X.Y.Z"
   git push origin vX.Y.Z
   ```

The `Release` workflow then:

1. refuses to continue if the tagged commit is not on `master` (`git merge-base --is-ancestor`), if
   `CHANGELOG.md` has no section for the tag, or if any test fails;
2. builds the image for linux/amd64 and linux/arm64 and pushes it to
   `ghcr.io/<owner>/cipherfilm` as `X.Y.Z`, and as `X.Y`, `X` and `latest` only where it is the highest release
   (a fix for an older line, `v2.0.9` after `v2.3.0`, gets `2.0.9` and `2.0` but leaves `2` and `latest` alone;
   pre-release tags such as `v1.1.0-rc.1` only get their own tag), with provenance and an SBOM;
3. builds the offline decrypt tool for macOS, Linux and Windows plus `SHA256SUMS`;
4. builds the Android APK (`cipherfilm-android-X.Y.Z.apk`, signed with the app signing key), the Google Play App
   Bundle (`cipherfilm-play-X.Y.Z.aab`, `CF_STORE=play`, signed with the key Play takes for uploads; see "Google Play" below), checks
   both for 16 KB memory pages (`mobile/scripts/check-page-size.sh`) and the Play manifest
   (`mobile/scripts/check-play-manifest.sh`), and builds the Mac app (`cipherfilm-mac-X.Y.Z.zip`, unsigned);
5. creates the GitHub Release with the changelog section as notes and everything attached, after checking that the
   tag still points at the commit that was built. On the public repository every attached file also gets a signed
   build provenance (`gh attestation verify <file> --repo <owner>/cipherfilm`): `SHA256SUMS` sits next to the files
   it covers, so it only catches a damaged download, while the attestation shows the file came from this workflow.
6. uploads the Play bundle to Google Play's **internal testing** track and promotes it to the closed test (track
   `alpha`), not for pre-releases (see "Google Play from CI" below). Production is a second, hand-started step: the
   **Google Play promote** workflow.

GitHub's macOS arm64 runners are sometimes unavailable for a long time ("not acquired by Runner … capacity
constraints"). The release then goes out without the Mac app. First choice: **Re-run failed jobs** on the release run
once runners are back; the release job then attaches the Mac app (with provenance) and a new `SHA256SUMS` to the
existing release, and Google Play is left alone. If that isn't possible, build it locally from the tagged commit and
attach it:

```bash
git worktree add /tmp/cf-rel vX.Y.Z && cd /tmp/cf-rel/mac
./scripts/fetch-onnxruntime.sh && ./scripts/bundle.sh
ditto -c -k --keepParent "build/Cipherfilm.app" cipherfilm-mac-X.Y.Z.zip
../scripts/check-artifacts.sh cipherfilm-mac-X.Y.Z.zip   # must say "clean"
gh release upload vX.Y.Z cipherfilm-mac-X.Y.Z.zip   # then add its line to SHA256SUMS
```

A Mac app attached this way has no build provenance (it was not built by the workflow). Say so in the release notes,
and attach it only from the tagged commit, built on your own machine.

**Nothing built on a personal machine goes up without `scripts/check-artifacts.sh`.** Compilers write source and
cache paths into binaries, and on a Mac those start with the home folder, which is named after the person. Releases
1.8.0 to 1.11.1 had locally built Mac apps and APKs with such paths; they were removed from the releases. The check
unpacks `.zip` and `.apk` files and fails on the home folder or the user name. `mac/scripts/bundle.sh` maps the
repository to `.` and the home folder to `~` for that reason. An Android APK built locally needs the same care:
build it from a worktree outside the home folder with `GRADLE_USER_HOME` there too (the native libraries keep
Gradle cache paths), then run the check. CI builds don't have the problem (their paths name no one).

The version is baked into the image: `docker run --rm ghcr.io/<owner>/cipherfilm:2 version`,
and it is shown in the admin area under Server.

## Google Play

The Play build differs from the GitHub APK only by `CF_STORE=play` at prebuild (`mobile/app.config.js`): no
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (the app opens Android's battery optimisation list instead of the direct
dialog) and no explicit search model (`mobile/src/store.ts`, docs/SEARCH.md). Requirements and the Play Console forms:
[docs/play/REQUIREMENTS.md](play/REQUIREMENTS.md).

Signing (Play App Signing, option B there): the **app signing key** is the existing release key
(`ANDROID_KEYSTORE_B64`, alias `cipherfilm`, certificate SHA-256
`87d9e9ab855b03e7d7d3152f5a76a4d8afb5d38efca3b9932ad93f1ba17c6712`), given to Google once with PEPK before the first
open-testing or production release, so Play and GitHub installs update each other. The bundle is signed with a
separate **upload key** (`ANDROID_UPLOAD_KEYSTORE_B64` / `ANDROID_UPLOAD_KEYSTORE_PASSWORD` in the `release`
environment, alias `upload`); Google can reset a lost upload key, never the app signing key. `withReleaseSigning`
takes the key from `CF_KEYSTORE`, `CF_KEYSTORE_PASSWORD`, `CF_KEY_ALIAS` (default `cipherfilm`) and
`CF_KEY_PASSWORD` (default: the keystore password); that is how `make play-aab` signs locally. In CI the keys never
meet the build: `android.yml` builds unsigned (`CF_UNSIGNED=1`) in a job without secrets, and a second job in the
`release` environment, which runs only Google's `zipalign` and `apksigner` and the JDK's `jarsigner`, checks the files
against the build job's checksums and signs them. It fails if the APK isn't signed with the app signing key.

Until Play Console accepts the upload key, the bundle is signed with the app signing key: the first upload to Play was
signed with it, so Play registered it as the upload key too. To switch: Play Console › Test and release › App
integrity › App signing › Request upload key reset, with the upload key's certificate
(`keytool -printcert -rfc -jarfile cipherfilm-play-X.Y.Z.aab` of a bundle signed with it), and once Google confirms,
set the variable `PLAY_UPLOAD_KEY` to `upload` in the `release` environment
(`gh variable set PLAY_UPLOAD_KEY --env release --body upload`). `android.yml` then requires the upload key.

The first upload, before any release built a bundle: `make play-aab VERSION=X.Y.Z` builds it locally the same way,
with the upload key in `~/.cipherfilm-android-signing` (`upload.p12`, `upload-password.txt`), into `dist/`. As with a
local APK, build from a worktree outside the home folder with `GRADLE_USER_HOME` outside it too (the script runs
`scripts/check-artifacts.sh` on the bundle). Each upload needs a new versionCode (`major*1e6+minor*1e3+patch`): a
rejected upload uses its number up.

### Google Play from CI

After the GitHub release, the `play` job in `release.yml` uploads `cipherfilm-play-X.Y.Z.aab` through the Google Play
Developer API to the **internal testing** track and from there to the **closed test** (`alpha`, the testers' Google
Group `cipherfilm-testers@googlegroups.com`; Play reviews closed-test releases) (`mobile/scripts/play.sh`: curl, openssl and jq; no third-party
action sees the key). Its "What's new" (at most 500 characters per language) comes from
`docs/play/listing/en-US/changelogs/<versionCode>.txt` and `docs/play/listing/de-DE/changelogs/<versionCode>.txt`
(versionCode as above, e.g. 2.1.1 → `2001001.txt`): write both with the CHANGELOG entry, short and for people using
the app. Without them English falls back to the Android lines of the CHANGELOG section and German is left out
(`mobile/scripts/play-notes.sh 2.1.1 /tmp/notes` shows what Play would get). While the app is still a draft in Play
Console (nothing reviewed yet), Play only takes draft releases: the job then creates one, and you roll it out on the
track in Play Console once.

**To production** (or closed/open testing), once the internal build looks right: Actions › **Google Play promote** ›
Run workflow, *Use workflow from* the tag `vX.Y.Z`, `to` = production, `rollout` = 1 (everyone) or e.g. 0.2 for a
staged rollout to 20 %. It gives the same release, with its notes, to that track; Play reviews it there. Or promote in
Play Console as before. A personal account's first production release needs the closed test and the
production-access application first ([docs/play/REQUIREMENTS.md](play/REQUIREMENTS.md) §3).

**One-time setup** (the app must already exist in Play Console, with the first bundle uploaded by hand):

1. [Google Cloud console](https://console.cloud.google.com/): create a project (e.g. `cipherfilm-play`) or pick one,
   then APIs & Services › Library › **Google Play Android Developer API** › Enable.
2. IAM & Admin › Service Accounts › Create service account (e.g. `play-publisher`), no roles in Google Cloud. Open it,
   Keys › Add key › Create new key › JSON. The file downloads once; it is a password for publishing the app.
3. [Play Console](https://play.google.com/console) › **Users and permissions** › Invite new users: the service
   account's e-mail (`play-publisher@<project>.iam.gserviceaccount.com`), App permissions › Cipherfilm with *Release
   apps to testing tracks* and *Release to production, exclude devices, and use Play App Signing* (only for the
   promote workflow) and *View app information*; no account permissions. Invite user. It can take up to a day until
   the API accepts the account.
4. GitHub › Settings › Environments › `release` › Add environment secret **`PLAY_SERVICE_ACCOUNT_JSON`**: the whole
   JSON file's contents. Then delete the downloaded file (keep no copy; a new key can be created any time, and an old
   one removed under Keys).

Without the secret the `play` job only warns and the bundle is uploaded by hand as before. To revoke: delete the key
in Google Cloud (Keys) or remove the user in Play Console.

## Dependencies

Dependabot opens one grouped pull request per area each week (Go server, decrypt tool, uploader, web, Android app
and its native module's Gradle files, Dockerfile, GitHub Actions, and the e2e stack with its compose images; Playwright's
browser image in `compose.e2e.yaml` takes its version from `@playwright/test` in `e2e/package.json`, through the
`Makefile`, so only the npm package is bumped) and merges it itself once the
full CI is green; major versions wait for a person (and a grouped pull request that a refresh turns into a major update
has its auto-merge turned off again). GitHub shows whether it accepted `.github/dependabot.yml` only on
Insights › Dependency graph › Dependabot: a rejected file stops every update without any other sign. What it doesn't do:

- **Security alerts for the Android app's Gradle libraries** come from `.github/workflows/android-deps.yml`, which
  reports them to the dependency graph (GitHub doesn't read Gradle builds itself). Docker images get no Dependabot
  alerts; `.github/workflows/image-scan.yml` scans the published server image with Trivy (weekly, after each
  release) and lists what it finds under Security › Code scanning.
- **The Mac app's Swift packages** (`swift-sodium`, pinned exactly in `mac/Package.swift`): the package needs the
  ONNX Runtime framework that `scripts/fetch-onnxruntime.sh` downloads, so Dependabot can't resolve it. Check
  swift-sodium's releases by hand before each release, like ONNX Runtime's version in that script.
- **Caddy's Cloudflare module** in `deploy/tailnet/domain/Dockerfile` (`xcaddy build --with
  github.com/caddy-dns/cloudflare@…`) is invisible to Dependabot; check its releases by hand.
- **Helper images** in the `Makefile` and `scripts/` (`alpine`, `golang`, `node`) are invisible to Dependabot.
  Check them by hand before each release; Go and Node must match the `Dockerfile`.

## First publish

Done for `ghcr.io/basmatiactivist/cipherfilm`, which is public. For a fork: GitHub creates the first image private; open
the package (`github.com/<owner>?tab=packages`), then Package settings, and set the visibility to public.

## Repository settings (public repository)

The workflows follow the usual supply-chain hardening (OpenSSF Scorecard, zizmor): every action is pinned to a
commit hash with its version as a comment (Dependabot keeps both current), every checkout drops its token
(`persist-credentials: false`), each job gets only the permissions it needs, a release uses no Actions caches at
all (no `actions/cache`, no cache in the `setup-*` actions, no buildx cache: the image is built with `no-cache`) and
checks what it downloads for the Android build against pinned hashes (NDK, Gradle, libsodium), only the jobs that sign
or push run in the `release` environment, new dependency versions wait a few days (`cooldown` in
`.github/dependabot.yml`), release files are checked for build paths before upload, and CodeQL and Scorecard run on
the public repository. Check the workflows after changing them:

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
docker run --rm -v "$PWD":/repo -w /repo ghcr.io/zizmorcore/zizmor:latest --offline .github/workflows
```

Settings that live on GitHub, not in the repository, set once the repository is public:

- **Actions › General:** workflow permissions "Read repository contents"; Actions may not create or approve pull
  requests; fork pull requests from outside collaborators need approval before their workflows run.
- **Allow auto-merge** (General), so Dependabot's minor and patch updates merge once the required checks pass, and
  the label `automerge` (it marks them; the merge works without it).
- **Ruleset for `master`:** no force pushes or deletion; pull requests need the checks `identity` (it checks the
  pull request's own commits), `tokens`, `server`, `web`, `mobile`, `android` (the app builds), `decrypt-tool` and `e2e`; the owner may bypass
  (to push directly).
- **Ruleset for tags `v*`:** only the owner may create, move or delete them (a tag starts a release).
- **Environment `release`** (Settings › Environments): holds the secrets `ANDROID_KEYSTORE_B64` and
  `ANDROID_KEYSTORE_PASSWORD` (the app signing key) and `ANDROID_UPLOAD_KEYSTORE_B64` and
  `ANDROID_UPLOAD_KEYSTORE_PASSWORD` (the Google Play upload key, alias `upload`) and `PLAY_SERVICE_ACCOUNT_JSON` (the
  service account that uploads to Google Play, "Google Play from CI" above) (environment secrets, not repository
  secrets; delete any repository-level copies), and the environment variable `PLAY_UPLOAD_KEY` (`upload` once Play
  accepted the upload key; "Google Play" above).
  Deployment branches and tags: "Selected branches and tags" with only the tag rule `v*`. The Android build and the
  image push run in it, so the signing key is out of reach of a branch, a pull request or a hand-started run on
  anything but a release tag. Without it the Android build has no signing key.
- **Security:** secret scanning with push protection, Dependabot alerts, private vulnerability reporting.
- The container package's visibility (above).

