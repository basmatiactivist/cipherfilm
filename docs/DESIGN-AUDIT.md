# Design audit: one system for web, Android and Mac

November 2026, with the `impeccable` skill: `audit` on the web, the native `audit` on Android and the Mac, and a
`critique`/`polish` pass on how the platforms match. The goal was refinement, not a redesign. "Tinte und Papier" stays
as it is: paper ground, ink text, one deep teal, and a serif for time and place. How the system works and how to change
a token is in [DESIGN.md](../DESIGN.md#tokens).

Evidence:
- Web: `impeccable detect` on the running client (1280x800 and 390x844), plus screenshots of nine screens in light and
  dark, desktop and phone, before and after (Playwright against a local test server).
- Android: emulator `cf` (API 37) with a test build, light and dark.
- Mac: the debug build's snapshot mode (`CF_SHOTS=1`, see `DebugDriver.swift`), light and dark.
- Everything ran against the local test instance (`mobile/dev/compose.yaml`) and its synthetic test images.

## Scores

| Platform | A11y | Performance | Theming | Responsive / Conformance | Integrity / Adaptivity | Total |
|---|---|---|---|---|---|---|
| Web, before | 4 | 3 | 3 | 4 | 4 | 18/20 |
| Web, after | 4 | 3 | 4 | 4 | 4 | 19/20 |
| Android, before | 3 | 3 | 2 | 3 | 3 | 14/20 |
| Android, after | 4 | 3 | 4 | 3 | 3 | 17/20 |
| Mac, before | 2 | 3 | 2 | 3 | 3 | 13/20 |
| Mac, after | 3 | 3 | 4 | 3 | 3 | 16/20 |

Performance was not the subject of this pass; nothing in it changed.

## The main finding: three palettes that had drifted apart

There was no single source of truth. Each client held its own copy of the colors, and the dark palettes had drifted:
- Android's night was `#14191d` / teal `#7cc4bc`, the Mac's `#171c21` / teal `#5fb3ac` with a warm grey for muted text,
  and the web's `#161b20` / teal `#6cbdb4`. The web's palette is the one DESIGN.md documents and the one checked at
  6:1 or more.
- Type sizes were set by hand on each screen: Android set `fontFamily: "serif", fontSize: 24` in 13 app bars, and its
  serif headings ran at Material's weight 500. The Mac used 11, 11.5, 12, 12.5, 13 and 13.5 pt side by side and
  serif sizes from 14 to 28 in eight steps.
- Radii: Android's tonal cards were 16 dp and its text fields 2 dp, against 8 and 6 everywhere else.

**Fixed.** `design/tokens/tokens.json` is now the one source. `design/tokens/build.mjs` writes it into
`web/src/tokens.css`, `mobile/src/tokens.ts` and `mac/Sources/Cipherfilm/Tokens.swift`, and checks 26 contrast pairs
in both modes. `make tokens-check` (part of `make test`) fails if a generated file is stale or a pair falls short. All
three apps now use the web's dark palette, one set of type roles, and the same radii.

## Findings

### Fixed

| Sev | Platform | Finding | Fix |
|---|---|---|---|
| P1 | Mac | The primary button drew white text on the light night teal: 2.46:1 in dark mode (WCAG 1.4.3 needs 4.5:1). | It uses `Ink.onTeal` (dark ink on teal in dark mode): 7.77:1. |
| P1 | Android | The ticked checkbox in Backup and Free up space cut its tick in white out of the night teal: 2.0:1. | The tick takes the theme's `onPrimary`: 7.77:1. |
| P1 | Mac | Text fields (sign-in, server, album names) showed no focus at all: `.plain` fields draw no ring, so a keyboard user could not see where typing would go. | The field's border turns 2 pt teal while it has the focus, as on the web. |
| P2 | All | Dark palettes differed per platform (see above). | One palette, generated. |
| P2 | Android | Material's `tertiaryContainer` was never mapped, so the "waiting" dot in Backup fell back to Material's stock pink: a second accent, against the One Teal Rule. | Tertiary is a quiet neutral (paper-deep / muted). |
| P2 | Android | Serif titles and headings hand-set per screen, at weight 500 (the web and Mac use 400). | App bars use `text.page`; day headings, section heads and album names use `text.heading` / `text.name` at 400. |
| P2 | Android | Tonal cards 16 dp, outlined fields 2 dp. | Cards 8 dp (`radius.card`), fields 6 dp (`radius.control`), like the web and Mac. |
| P2 | Android | The unchecked selection ring was a white ring on a black wash, unlike the web's paper dot with a teal edge. | Same dot as the web: 26 dp, paper wash, 2 dp teal edge. |
| P2 | Mac | Half-point text sizes (11.5, 12.5, 13.5) blurred the hierarchy; eight serif sizes. | Five sans steps (10, 11, 12, 13, 15) and six serif roles, all in `Typo`. |
| P2 | Mac | The favorite heart on a tile floated with a drop shadow, while the web and Android put it in the dark badge disc; the video badge used plain black. | Both use the shared `badge` color and disc. |
| P2 | Web | The toast's dismiss button and an upload's cancel button are 32 px: fine with a mouse, small for a finger. | They grow to 44 px on touch screens (`pointer: coarse`). |
| P3 | Mac | Error notes had a 40% border, the web's a solid one. | Solid border. |
| P3 | Mac | The drop veil's dashed edge was 2 pt, the web's 3 px. | 3 pt. |
| P3 | All | The viewer's black-and-white values were literals in three places. | `stage` tokens (fixed in both modes). |

### Left as they are, and why

| Sev | Platform | Finding | Why it stays |
|---|---|---|---|
| P2 | All | Input borders (`rule-strong` on card) are 1.7:1, below the 3:1 that WCAG 1.4.11 asks of a component's boundary. | Every field has a visible label above it and a teal focus state, and the sand hairline is the identity the user likes. Darkening it to 3:1 would make every field and button border heavy. Revisit if someone has trouble finding fields. |
| P2 | Web | Detector: `cream-palette` (warm off-white ground). | False positive by brief: the paper ground is the chosen world ("Tinte und Papier"). |
| P3 | Android | Buttons are 10 dp round (Material's roundness × 5), the web's 6 px. | Material buttons are pill-shaped by default; 10 dp is already the compromise. Forcing 6 dp would read as a web port on Android. |
| P3 | Mac | Prev/next in the viewer are dark discs; on the web they are light discs. | On the Mac they sit over the photo, where a dark disc stays legible over a bright image. Both use the stage tokens. |
| P3 | Mac | Buttons are 30 pt, not 44. | macOS is a pointer platform; 30 pt is above the system's own controls. Touch sizes apply to the web and Android. |
| P3 | Web | Off-grid half steps (2, 6, 10, 14 px) remain in some gaps and paddings. | They align icons with text optically; every on-grid value now uses the `--space-*` tokens. |
| P3 | Android | "Shake to lock" and "Free up space" share the phone icon in Account. | Copy and icon choice, not the design system; worth a look when the icon set grows. |
| — | Mac | The Settings window was not captured in the screenshots. | The SwiftUI Settings scene cannot be opened from code in this build; it is a standard macOS form. |

## Positive findings

- The web was already almost fully tokenised, with focus rings, reduced-motion handling, forced-colors support,
  44 px targets and an axe check in the e2e suite. Its tokenised build renders pixel for pixel as before (all 36
  screenshots are byte-identical).
- Android already used Material color roles everywhere. Only the role mapping and a few literals had to move.
- All three apps keep the serif to time and place, use one icon language each, and stay flat at rest.

## Next steps

- `/impeccable polish` the Mac Settings window by hand once it can be screenshotted.
- If the brief changes, consider `rule-strong` at 3:1 for field boundaries (see above).
