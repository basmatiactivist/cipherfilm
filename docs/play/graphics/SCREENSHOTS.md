# Play screenshots: what to capture and how to frame it

Capture on the emulator (or a phone) signed in to the **demo server** (`https://demo.cipherfilm.app`), never the
production instance. Use only the neutral demo library: no real faces of private people, nothing suggestive, no
file names or e-mail addresses other than `reviewer@cipherfilm.app`. The explicit-content search is not in the
Play build and must not appear anywhere.

## Play rules (phone)

- 2 to 8 screenshots; upload **8** in the order below. For recommendation eligibility: at least 4 at ≥ 1080 px.
- JPEG or **24-bit PNG, no alpha** (`frame.mjs` writes opaque PNGs).
- Each side 320 to 3840 px, long side at most 2 × the short side. Portrait **1080×1920** (9:16) is the default
  output of `frame.mjs`; raw emulator captures of 1080×2400 are 20:9 and are *over* the 2:1 limit, so always
  frame them (or crop) before upload.
- They must show the real app. Captions on a band are fine; mock-ups of features that do not exist are not.

## Emulator setup

- Pixel-class device, 1080×2400 (420 dpi), Android 15 or 16, **light theme**, English UI (the app is English only;
  the DE listing uses the same raw shots with German captions).
- Clean status bar (demo mode):
  ```bash
  adb shell settings put global sysui_demo_allowed 1
  adb shell am broadcast -a com.android.systemui.demo -e command enter
  adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
  adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
  adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4
  adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
  ```
  (For shot 5 turn notifications back on: `-e visible true`.)
- Capture: `adb exec-out screencap -p > raw/01-timeline.png`.

## Shots, in upload order

| # | File | Screen and state | Caption EN | Caption DE |
|---|---|---|---|---|
| 1 | `01-timeline` | **Photos** (timeline), scrolled to a day with a varied grid of demo photos, day headings visible | Your photos, encrypted on your phone | Ihre Fotos, auf dem Handy verschlüsselt |
| 2 | `02-search` | **Search**, query `beach` (or `dog`) typed, results grid shown | Find photos by what is in them | Fotos nach Inhalt finden |
| 3 | `03-people` | **People**, a few named demo people (use CC0 / consented demo faces only; if none are available, skip this shot) | Faces grouped on your device | Gesichter, erkannt auf dem Gerät |
| 4 | `04-album` | An **album** opened (e.g. "Hiking 2026"), with its grid | Albums, favourites and a calm timeline | Alben, Favoriten, ruhige Zeitleiste |
| 5 | `05-backup` | **Backup** screen with folders chosen, "Back up automatically" on, a run in progress (progress visible); optionally pull down the shade to show the upload notification | Automatic backup to your own server | Automatisches Backup auf Ihren Server |
| 6 | `06-unlock` | **Unlock** screen with the system fingerprint prompt showing ("Unlock with fingerprint or face") | Unlock with your fingerprint | Mit Fingerabdruck entsperren |
| 7 | `07-share` | Android **share sheet** from the Files/Gallery app with Cipherfilm as target, or Cipherfilm's **share** screen right after (items listed, Upload button) | Share from any app to upload | Aus jeder App teilen und hochladen |
| 8 | `08-privacy` | **Account** screen: App lock, "Unlock with fingerprint or face", "Shake to lock and close", privacy policy link, About/version | No ads, no tracking, no account with us | Keine Werbung, kein Tracking, kein Konto bei uns |

Optional replacement for 4 or 7: **Free up space** screen with the amount that can be freed:
EN "Free up space, safely" / DE "Speicher freigeben, sicher".

Optional sub-lines (`--sub`), kept short and identical in spirit across languages:

| # | EN | DE |
|---|---|---|
| 1 | Your server stores only ciphertext | Ihr Server speichert nur Chiffretext |
| 2 | Search runs on the phone | Die Suche läuft auf dem Handy |
| 5 | Needs your own Cipherfilm server | Benötigt Ihren eigenen Cipherfilm-Server |

## Framing

`frame.mjs` puts a paper-coloured caption band (brand serif, ink) above the screenshot, scales the screenshot into
the rest of the canvas with rounded corners and a hairline, and writes an opaque PNG. It uses `sharp`
(looked up in `web/node_modules`, `~/Desktop/cipherfilm-site/node_modules` or `$SHARP_FROM`). Fonts come from the
system (Georgia, Helvetica Neue on macOS).

```bash
G=docs/play/graphics
mkdir -p /tmp/cf-shots/en-US /tmp/cf-shots/de-DE
node $G/frame.mjs raw/01-timeline.png /tmp/cf-shots/en-US/01.png "Your photos, encrypted on your phone" --sub "Your server stores only ciphertext"
node $G/frame.mjs raw/01-timeline.png /tmp/cf-shots/de-DE/01.png "Ihre Fotos, auf dem Handy verschlüsselt" --sub "Ihr Server speichert nur Chiffretext"
# … one line per shot and language; --size 1080x2160 for a taller (2:1) canvas
```

For fastlane `supply`, put the results in `listing/<locale>/images/phoneScreenshots/1.png … 8.png`, and
`icon-512.png` / the feature graphic as `listing/<locale>/images/icon.png` and `featureGraphic.png`.
Delete the scratch output in `/tmp/cf-shots` afterwards.

## Checklist before upload

- [ ] 1080 px wide, ≤ 2:1, no alpha (`frame.mjs` prints `channels=3, alpha=false`).
- [ ] Demo data only; no real names, e-mails or private faces; no explicit-content UI.
- [ ] Same raw shots for EN and DE, captions swapped.
- [ ] Captions fit on at most two lines (keep them ≤ ~40 characters).
