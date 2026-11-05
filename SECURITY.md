# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting ("Security" tab, "Report a
vulnerability") on this repository. Include what you found, how to reproduce it (a local test is ideal) and what you
think the impact is. Expect an answer within a few days; this is a small project maintained in spare time.

## What this project does and does not promise

- Photos, file names, capture dates, EXIF and album names are encrypted in the browser. The server stores ciphertext and
  learns what is listed in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (sizes, counts, times, e-mail addresses, album structure).
- **A web app cannot protect you from whoever controls the server**: that party can deliver modified JavaScript. See the
  threat model.
- There is no two-factor authentication yet.

## Audit status

The code was reviewed in three rounds by AI agents working from the source (reconnaissance, hunting, independent verification).
Every confirmed finding was fixed and covered by a regression test. In total: round 1 found 8 records (5 low, 1 medium,
2 needing deployment validation), round 2 found 3 (a medium and a low, plus one that depends on the deployment), round 3 found 4 (all low or informational:
a last-administrator race, a selection bug that could trash hidden photos, concurrent invite acceptance, a stale README claim).
This is **not** an independent human audit and not a guarantee that no issues remain. Scope of round 3 was the code
added since round 2; the Tailscale and Caddy overlays were never exercised on a real server.

## Supported versions

Only the latest commit on the default branch.
