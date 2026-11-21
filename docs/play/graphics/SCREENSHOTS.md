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

- Pixel-class device, 1080×2400 (420 dpi), Android 15 or 16, **light theme**, English UI (the app is in English and
  German; set the emulator's or the app's language to English. The DE listing uses the same raw shots with German
  captions, or German shots taken the same way).
- Release builds block screenshots: after signing in, turn on Account › **Allow screenshots** (it goes off again at
  sign-out), else `screencap` returns a black image.
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

Captured 2026-11-21 with 2.11.1 on the demo server (`reviewer@`). The raw captures are in `screenshots/raw/`; the
framed ones are the store's, in `listing/<locale>/images/phoneScreenshots/`.

| # | File | Screen and state | Caption EN (sub) | Caption DE (sub) |
|---|---|---|---|---|
| 1 | `01-timeline` | **Photos**: "Your years" and a day of demo photos | Your photos, encrypted on your phone (Backed up to your own server) | Ihre Fotos, auf dem Handy verschlüsselt (Gesichert auf Ihrem eigenen Server) |
| 2 | `02-search` | **Search** `harbour`: only demo photos in the results (other words also find the test images in the reviewer library) | Find photos by what is in them (Search runs on the phone) | Fotos nach Inhalt finden (Die Suche läuft auf dem Handy) |
| 3 | `03-year-in-review` | A year in review playing as a story, its cover | Your year in review, as a story | Ihr Jahr im Rückblick, als Story |
| 4 | `04-custom-reviews` | **Photos** with "Your reviews" (a weekly review "bridges") above "Your years" | Your own reviews, daily to monthly (Different photos each time) | Eigene Rückblicke, täglich bis monatlich (Jedes Mal andere Fotos) |
| 5 | `05-albums` | **Albums**: Favorites, Archive, Locked folder, albums | Albums, archive and a locked folder | Alben, Archiv und gesperrter Ordner |
| 6 | `06-map` | **Map** with photo pins | Your photos on a map (Off until you turn it on) | Ihre Fotos auf der Karte (Aus, bis Sie sie einschalten) |
| 7 | `07-backup` | **Backup**, automatic backup on, all Android settings ticked; cut above the folder list | Automatic backup to your own server (Needs your own Cipherfilm server) | Automatisches Backup auf Ihren Server (Benötigt Ihren eigenen Cipherfilm-Server) |
| 8 | `08-locks` | **Account** scrolled to the lock settings (never the top of Account: it lists the account's devices) | Locks itself. No ads, no tracking (Unlock with your fingerprint) | Sperrt sich selbst. Ohne Werbung, ohne Tracking (Mit Fingerabdruck entsperren) |

The status bar's notification icons were painted over in the background colour (system UI, not the app).
The system fingerprint prompt can't be captured (it is a secure window), so the locks are shown in Account.

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
