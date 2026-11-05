# Cipherfilm app icon

Author: basmatiactivist

## Chosen: variant D, "padlock corner"

An ink-line photo print (frame, two-peak ridge, sun) with a teal padlock over its
lower-right corner. A paper gap separates the padlock from the print. A stranger reads
it as "photos" and "locked" at the same moment, at 192 px and at 48 px. The padlock is
drawn rather than taken from clip-art. The body is 1 : 0.8, the shackle is 62 % of the
body width with a round crown, and there is a slotted keyhole. Teal is used only on the
padlock, so the one accent means "encrypted". The mark fits the Android 66 dp safe zone
and holds in circle, squircle and rounded-square masks.

Optical centring: the padlock's solid mass pulled the mark right. The mark is therefore
shifted by `translate(-19 6)` on the 1024 canvas (the same group is used in the Android
layers, where it is about -1.34 / +0.42 dp). After the shift, the ink-weighted centroid
(padlock included) sits on the tile centre. The bounding-box centre is 2.3 % left of
centre and 0.6 % above it. The favicon is shifted by `translate(-0.27 -0.27)` on its 24 grid.

## All explored variants (`variants/`, SVG plus 512, 48 and 16 px PNGs)

Round 2, sealed print (photo-first, no encryption cue):
- `a-sealed-print`: print with a teal seal on its bottom edge. Clean, but the dot did not
  read as encryption.
- `b-print-stack`: two prints. Reads as a gallery, but busy, and the seal looks like a camera button.
- `c-photo-corners`: album mounting corners. They read as a crop or full-screen glyph.

Round 3, encryption cue:
- `d-padlock-corner` (**chosen**): fastest "encrypted photos" read at every size.
- `e-cipher-blocks`: half the landscape turns into teal blocks. At 48 px it reads as a
  bar chart or pixel art, not encryption.
- `f-padlock-body`: the print is a padlock body with a teal shackle. It is a strong single
  silhouette, but the wide body makes it read as a shopping bag or handbag.
- `g-keyhole-sun`: a teal keyhole replaces the sun. It reads as a person or pawn silhouette.

The envelope-and-seal direction from round 1 was dropped because it read as an e-mail app.

## Colours

| Role | Hex |
| --- | --- |
| Tile / adaptive background (paper) | `#FAF7F2` |
| Print lines, sun (ink) | `#1F2A33` |
| Padlock (teal) | `#1F6F6B` |
| Keyhole and gap (paper) | `#FAF7F2` |

The monochrome layer is a single colour (`#000000`, tinted by the system). The gap and the
keyhole are transparent cut-outs.

## Files

- `icon.svg`, `icon-1024.png`: full square icon, no baked corners (PWA, stores).
- `android-foreground.svg` / `-background.svg` / `-monochrome.svg` (108 dp) and their
  `*-432.png` renders. The mark is the 1024 artwork scaled into the 72 dp visible area
  and stays inside the 66 dp safe zone.
- `favicon.svg`, `favicon-32.png`: a 24-grid redraw for 16 px. It has a simpler ridge, no
  sun, a larger padlock and heavier strokes, on a paper tile so it holds on dark tabs.
- `favicon-180.png`: apple-touch icon (`icon.svg` at 180 px).
- `preview.png`: masks at 192 and 48 px on light and dark backgrounds, the favicon on
  tabs, and the themed (monochrome) icon.
