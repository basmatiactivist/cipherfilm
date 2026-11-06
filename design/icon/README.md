# Cipherfilm app icon

Author: basmatiactivist

## Chosen (2.x): "Photo lock"

One teal padlock whose body is the photo: the ridge and the sun are cut out of the body, where a keyhole would be.
It is one shape in one colour, so it never reads as two clip-arts glued together, and it says "photos, locked" at
192 px and still "lock" at 16 px. The shackle is thick and 62 % of the body width, and the body keeps a photo's
proportions, so it does not turn into a handbag (see variant f below). Picked from three rounds of concepts made for
the website (kept in the website repository under `design/logo-concepts/`).

- 24 grid: shackle `M6.8 10V7.2A5.2 5.2 0 0 1 17.2 7.2V10H14.6V7.2A2.6 2.6 0 0 0 9.4 7.2V10Z`; body a 16.8 x 12.6
  rounded rectangle (r 2.2) at 3.6, 9.4 with the ridge and the sun cut out (even-odd). The favicon redraw uses a
  slightly thicker shackle (5.4 / 2.4) and larger cut-outs for 16 px.
- Android: the mark at 2.3x on the 108 dp canvas, centred, inside the 66 dp safe zone; background paper; monochrome
  is the same shape in black.
- In code: `web/src/icons.tsx` (`Logo`) and `mac/Sources/Cipherfilm/Theme.swift` (`PhotoLock`, `Mark`, `MenuBarIcon`)
  draw the same shapes in the theme's teal (template black in the menu bar).
- `mac/scripts/make-icon.swift` builds `AppIcon.icns` from `icon-1024.png`.

Until 1.x the icon was variant D below ("padlock corner").

## Variants explored for 1.x (not kept in this repository)

Round 2, sealed print (photo-first, no encryption cue):
- `a-sealed-print`: print with a teal seal on its bottom edge. Clean, but the dot did not
  read as encryption.
- `b-print-stack`: two prints. Reads as a gallery, but busy, and the seal looks like a camera button.
- `c-photo-corners`: album mounting corners. They read as a crop or full-screen glyph.

Round 3, encryption cue:
- `d-padlock-corner` (**the 1.x icon**): fastest "encrypted photos" read at every size.
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
| Padlock with the photo (teal) | `#1F6F6B` |

The ridge and the sun are cut-outs, so the paper shows through. The monochrome layer is the same shape in a single
colour (`#000000`, tinted by the system).

## Files

- `icon.svg`, `icon-1024.png`: full square icon, no baked corners (PWA, stores).
- `android-foreground.svg` / `-background.svg` / `-monochrome.svg` (108 dp) and their
  `*-432.png` renders. The mark is the 1024 artwork scaled into the 72 dp visible area
  and stays inside the 66 dp safe zone.
- `favicon.svg`, `favicon-32.png`: a 24-grid redraw for 16 px, with a thicker shackle and larger
  cut-outs, on a paper tile so it holds on dark tabs.
- `favicon-180.png`: apple-touch icon (`icon.svg` at 180 px).
- `preview.png`: masks at 192 and 48 px on light and dark backgrounds, the favicon on
  tabs, and the themed (monochrome) icon.
