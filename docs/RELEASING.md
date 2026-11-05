# Releasing

Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **PATCH** (1.0.1): bug and security fixes, dependency updates, no changes to stored data.
- **MINOR** (1.1.0): new features; database changes are applied automatically and are backward compatible.
- **MAJOR** (2.0.0): anything that needs action from the operator or changes the encrypted format.
  The crypto format version is part of `docs/CRYPTO.md`; a format change is always a major release.

## Cutting a release

1. Move the entries from `## [Unreleased]` in `CHANGELOG.md` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
2. Commit that on `master` and wait for CI to pass.
3. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m "Cipherfilm X.Y.Z"
   git push origin vX.Y.Z
   ```

The `Release` workflow then:

1. refuses to continue if `CHANGELOG.md` has no section for the tag, or if any test fails;
2. builds the image for linux/amd64 and linux/arm64 and pushes it to
   `ghcr.io/<owner>/cipherfilm` as `X.Y.Z`, `X.Y`, `X` and `latest`
   (pre-release tags such as `v1.1.0-rc.1` only get their own tag), with provenance and an SBOM;
3. builds the offline decrypt tool for macOS, Linux and Windows plus `SHA256SUMS`;
4. builds the Android APK and the Mac app (`cipherfilm-mac-X.Y.Z.zip`, unsigned);
5. creates the GitHub Release with the changelog section as notes and everything attached.

GitHub's macOS arm64 runners are sometimes unavailable for a long time ("not acquired by Runner … capacity
constraints"). The release then goes out without the Mac app. Build it locally from the tagged commit and attach it:

```bash
git worktree add /tmp/cf-rel vX.Y.Z && cd /tmp/cf-rel/mac
./scripts/fetch-onnxruntime.sh && ./scripts/bundle.sh
ditto -c -k --keepParent "build/Cipherfilm.app" cipherfilm-mac-X.Y.Z.zip
../scripts/check-artifacts.sh cipherfilm-mac-X.Y.Z.zip   # must say "clean"
gh release upload vX.Y.Z cipherfilm-mac-X.Y.Z.zip   # then add its line to SHA256SUMS
```

**Nothing built on a personal machine goes up without `scripts/check-artifacts.sh`.** Compilers write source and
cache paths into binaries, and on a Mac those start with the home folder, which is named after the person. Releases
1.8.0 to 1.11.1 had locally built Mac apps and APKs with such paths; they were removed from the releases. The check
unpacks `.zip` and `.apk` files and fails on the home folder or the user name. `mac/scripts/bundle.sh` maps the
repository to `.` and the home folder to `~` for that reason. An Android APK built locally needs the same care:
build it from a worktree outside the home folder with `GRADLE_USER_HOME` there too (the native libraries keep
Gradle cache paths), then run the check. CI builds don't have the problem (their paths name no one).

The version is baked into the image: `docker run --rm ghcr.io/<owner>/cipherfilm:2 version`,
and it is shown in the admin area under Server.

## Dependencies

Dependabot opens one grouped pull request per area each week (Go server, decrypt tool, web, e2e, Dockerfile,
compose files, GitHub Actions) and merges it itself once the full CI is green; major versions wait for a
person. Two things it can't do alone:

- **Playwright** is pinned twice and both must match: `@playwright/test` in `e2e/package.json` and the
  `mcr.microsoft.com/playwright:vX.Y.Z-noble` image in `compose.e2e.yaml`. A pull request that bumps only one
  fails the e2e job; bump the other in the same branch.
- **Helper images** in the `Makefile` and `scripts/` (`alpine`, `golang`, `node`) are invisible to Dependabot.
  Check them by hand before each release; Go and Node must match the `Dockerfile`.

## First publish

The first image is created private by GitHub. To let others pull it, open the package
(`github.com/<owner>?tab=packages`), then Package settings, and set the visibility to public.

## Repository settings (public repository)

The workflows follow the usual supply-chain hardening (OpenSSF Scorecard, zizmor): every action is pinned to a
commit hash with its version as a comment (Dependabot keeps both current), every checkout drops its token
(`persist-credentials: false`), each job gets only the permissions it needs, a release builds without caches and
hands the Android build only the two signing secrets, new dependency versions wait a few days (`cooldown` in
`.github/dependabot.yml`), release files are checked for build paths before upload, and CodeQL and Scorecard run on
the public repository. Check the workflows after changing them:

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
docker run --rm -v "$PWD":/repo -w /repo ghcr.io/zizmorcore/zizmor:latest --offline .github/workflows
```

Settings that live on GitHub, not in the repository, set once the repository is public:

- **Actions › General:** workflow permissions "Read repository contents"; Actions may not create or approve pull
  requests; fork pull requests from outside collaborators need approval before their workflows run.
- **Allow auto-merge** (General), so Dependabot's minor and patch updates merge once the required checks pass.
- **Ruleset for `master`:** no force pushes or deletion; pull requests need the checks `identity`, `server`, `web`,
  `mobile`, `decrypt-tool` and `e2e`; the owner may bypass (to push directly).
- **Ruleset for tags `v*`:** only the owner may create, move or delete them (a tag starts a release).
- **Security:** secret scanning with push protection, Dependabot alerts, private vulnerability reporting.
- The container package's visibility (above).

