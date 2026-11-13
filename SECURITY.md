# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting:
<https://github.com/basmatiactivist/cipherfilm/security/advisories/new> ("Security" tab, "Report a vulnerability").
If you can't use GitHub, write to <contact@cipherfilm.app>. Include what you found, how to reproduce it (a local test is ideal) and what you
think the impact is. Expect an answer within a few days; this is a small project maintained in spare time.

## What this project does and does not promise

- Photos, file names, capture dates, EXIF and album names are encrypted in the browser. The server stores ciphertext and
  learns what is listed in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (sizes, counts, times, e-mail addresses, album structure).
- **A web app cannot protect you from whoever controls the server**: that party can deliver modified JavaScript. See the
  threat model.
- Two-step sign-in (a code from an authenticator app or a passkey, with one-time recovery codes) is optional and off
  by default. It protects the sign-in, not the encryption: the password still derives the keys. Whoever runs the
  server could make codes, since it must know the secret to check them (see the threat model).

## Audit status

The code was reviewed in four rounds by AI agents working from the source (reconnaissance, hunting, independent verification).
Every confirmed finding was fixed and covered by a regression test. In total: round 1 found 8 records (5 low, 1 medium,
2 needing deployment validation), round 2 found 3 (a medium and a low, plus one that depends on the deployment), round 3 found 4 (all low or informational:
a last-administrator race, a selection bug that could trash hidden photos, concurrent invite acceptance, a stale README claim).
This is **not** an independent human audit and not a guarantee that no issues remain. Scope of round 3 was the code
added since round 2. Round 4 covered the whole repository again and found 8 records (1 medium, 6 low, 1 informational: quota
accounting of the search index, two account or server mix-ups in the Android app, the activity log, recovery behind a shared address,
sign-outs lost by a restore, paths in the decrypt tool, a stale rate-limit claim), plus 23 whose impact depends on the
deployment or a platform fact; the server-side ones of those were hardened too. A real server runs behind Tailscale; the e2e
tests run behind Caddy. Other proxies were not exercised.

## Supported versions

Only the latest release (and the default branch it is tagged from). Fixes ship as a new release; older releases
get no backports. The server, the web app, the Android and the Mac app are released together with one version
number; keep them on the same version where you can.
