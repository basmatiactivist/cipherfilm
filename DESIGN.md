---
name: Cipherfilm
description: A private, end-to-end encrypted photo gallery set in ink on warm paper with one deep teal.
colors:
  paper: "#faf7f2"
  paper-deep: "#f3eee5"
  card: "#fffefb"
  ink: "#1f2a33"
  muted: "#4b5963"
  faint: "#5f6c76"
  rule: "#e6dfd3"
  rule-strong: "#cfc6b6"
  teal: "#1f6f6b"
  teal-ink: "#17524f"
  teal-tint: "#e3eeeb"
  danger: "#a3261f"
  danger-tint: "#f8e6e3"
  ok: "#1e6b45"
  ok-tint: "#e4f1ea"
  lightbox-black: "#000000"
typography:
  page-title:
    fontFamily: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.2
  auth-title:
    fontFamily: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif"
    fontSize: "1.625rem"
    fontWeight: 400
    lineHeight: 1.2
  day-heading:
    fontFamily: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif"
    fontSize: "1.0625rem"
    fontWeight: 400
  brand:
    fontFamily: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif"
    fontSize: "1.1875rem"
    letterSpacing: "0.005em"
  panel-title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  pill: "4px"
  control: "6px"
  card: "8px"
  round: "50%"
spacing:
  grid-gap: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  content-x: "32px"
  touch: "44px"
  topbar: "56px"
  sidebar: "232px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.teal-ink}"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.teal-tint}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "44px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
    height: "44px"
  input-search:
    backgroundColor: "{colors.paper-deep}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "28px 24px 24px"
  panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "20px"
  navitem:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 12px"
  navitem-current:
    backgroundColor: "{colors.teal-tint}"
    textColor: "{colors.teal-ink}"
  pill:
    backgroundColor: "{colors.teal-tint}"
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.pill}"
  tile:
    backgroundColor: "{colors.paper-deep}"
    rounded: "3px"
  accordion:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    height: "64px"
  lightbox-button:
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    size: "44px"
---

# Design System: Cipherfilm

## Overview

**Creative North Star: "Tinte und Papier"**

Ink on warm paper. The signed-in app is a quiet desk: a cream ground (#faf7f2), blue-black ink text, hairline rules in sand, and a single deep teal that marks everything actionable or current. The photos supply all the color; the chrome stays out of their way. Density is calm, controls are generous (44px touch targets throughout), and nothing floats, glows or casts a shadow unless it is a menu or the drag tray.

The serif is a typographic signature held back for a few places: the brand name, day headings in the timeline, page titles and auth card titles, plus album names. Everything else is the system sans. The logo is the app icon's mark, "Photo lock": one teal padlock whose body is the photo, with the ridge and the sun cut out of it. Sources and every size live in design/icon/.

**Key Characteristics:**
- Warm paper ground, ink text, exactly one accent (deep teal).
- Flat: borders and tonal steps carry structure; shadows only on the avatar menu and drag tray (and a faint lift on the selection bar).
- Small radii: 6px controls, 8px cards and panels.
- Serif for headings of time and place; sans for everything operational.
- One hand-drawn icon set (24px grid, 1.8 stroke, currentColor), inline SVG.
- Equal care for phone and desktop: sidebar becomes a bottom tab bar at 860px.
- One system across the web, the Android app and the Mac app: the same tokens, each in its platform's own form.

## Tokens

Every value on this page lives in one file, `design/tokens/tokens.json`. `design/tokens/build.mjs` (plain Node, no
dependencies) writes it into each client:

| Client | Generated file | How it is used |
|---|---|---|
| Web | `web/src/tokens.css` | CSS custom properties, imported first by `styles.css`; dark values under `prefers-color-scheme: dark` |
| Android | `mobile/src/tokens.ts` | `light` / `dark` palettes become Material roles in `theme.ts`; `text`, `radius`, `space`, `stage` are used directly |
| Mac | `mac/Sources/Cipherfilm/Tokens.swift` | `Ink.<role>` colors (light/dark resolved by the window's appearance), `Typo`, `Space`, `Radius`, `Metric`, `Motion` |

What the JSON holds:
- **color**: 26 roles, each with a light and a dark value (paper, paper-deep, card, ink, muted, faint, rule, rule-strong,
  teal, teal-ink, teal-tint, teal-over, on-teal, danger, danger-ink, danger-press, danger-tint, on-danger, ok, ok-tint,
  and the veils and shades). Names are kebab-case in CSS (`--teal-ink`) and camelCase in TypeScript and Swift (`tealInk`).
- **stage**: the photo viewer's colors, the same in both modes (black ground, white text, the translucent button states,
  the dark tile badge).
- **type**: roles, not sizes (`page`, `auth`, `dialog`, `brand`, `heading`, `name`, `title`, `body`, `label`, `caption`,
  `small`, `micro`). Each role has a size per platform because each platform has its own base: web 16 px, Android 16 sp,
  macOS 13 pt. The serif roles are the "time and place" ones.
- **space** (the 4-point steps), **radius** (tile 3, pill 4, control 6, card 8), **size** (touch 44 web / 48 Android,
  Mac control and field heights, top bar, sidebar, icon grid, focus ring, measure), **elevation** (the two shadows),
  **motion** (150 and 250 ms, two curves).
- **contrast**: the text and surface pairs the build checks in light and dark, each with its minimum ratio.

### Changing a token

1. Edit `design/tokens/tokens.json` (for a color, change both `light` and `dark`).
2. Run `make tokens` (or `node design/tokens/build.mjs`). It rewrites the three generated files and refuses if a listed
   contrast pair falls below its minimum.
3. Commit the JSON together with the three generated files. `make tokens-check`, part of `make test`, fails when they
   are out of step.
4. Look at the change on all three clients, in light and dark.

Never edit the generated files by hand, and don't add literal colors, radii or type sizes in the clients: add a token
or use an existing role. A new role is added to the JSON once and appears on every platform at the next build.

## Colors

A restrained paper-and-ink palette with one teal and two status hues used only for state.

### Primary
- **Deep Teal** (#1f6f6b, `teal`): primary buttons, links, focus ring, selection, progress fills, selected-tile outline, panel icons.
- **Pressed Teal** (#17524f, `teal-ink`): button hover, current nav text, link hover, accordion titles, secondary-button text.
- **Teal Wash** (#e3eeeb, `teal-tint`): current nav item, pills, avatar fill, hover for secondary buttons, empty-state icon disc, drop veil.

### Neutral
- **Warm Paper** (#faf7f2, `paper`): page, top bar and sidebar ground.
- **Deep Paper** (#f3eee5, `paper-deep`): search field, tile placeholders, hover fills, read-only inputs, empty states, recovery word grid.
- **Card White** (#fffefb, `card`): cards, panels, inputs, menus, selection bar.
- **Ink** (#1f2a33, `ink`): body text.
- **Slate Muted** (#4b5963, `muted`) and **Slate Faint** (#5f6c76, `faint`): secondary text, and placeholder/icon/disabled text respectively.
- **Sand Rule** (#e6dfd3, `rule`) and **Strong Sand** (#cfc6b6, `rule-strong`): hairlines; input borders and open-state borders.
- **Lightbox Black** (#000000): the lightbox ground only.

### Status
- **Brick** (#a3261f, `danger`) on **Brick Wash** (#f8e6e3): errors, destructive buttons, disabled/invited pills, unverifiable tiles.
- **Moss** (#1e6b45, `ok`) on **Moss Wash** (#e4f1ea): confirmation notes, active pills.

### Night
With `prefers-color-scheme: dark` the same tokens turn over: the ink becomes the ground (#161b20 page, #1e252b deep, #1b2127 card), the paper the writing (#ebe5da, muted #b4bcc2, faint #9aa4ab), rules #2b343b and #3e4851, teal lifts to #6cbdb4 (pressed #8fd0c8, wash #1d3532) with dark text on teal fills (#0e1f1d), brick #f08a80 on #3a1f1d, moss #7fcf9f on #1b3326. Every text pair stays at 6:1 or more. The lightbox is black in both.
The Android and Mac apps use exactly this night palette (they read it from the same tokens); text on a teal or brick
fill turns dark in dark mode (`on-teal`, `on-danger`), never white on the lighter teal.

### Named Rules
**The One Teal Rule.** Teal is the only accent. Status hues appear only to report state, never to decorate.

**The Photos Carry Color Rule.** Chrome stays paper, ink and teal so uploaded imagery is the most colorful thing on screen.

## Typography

**Serif:** Georgia (with Iowan Old Style, Palatino Linotype, Times New Roman)
**Sans:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial)

**Character:** A bookish serif for names of days, pages and the product, set against a neutral system sans. Self-hosted/system faces only (strict CSP, no external fonts).

### Hierarchy
- **Page title** (serif 400, 1.75rem, 1.2; 1.5rem on phones): Timeline, Albums, Trash, Account, Admin, album names.
- **Auth title** (serif 400, 1.625rem, 1.2, balanced wrap): signed-out card headings.
- **Day heading** (serif 400, 1.0625rem): one per capture day in the timeline; also album names in the album grid.
- **Brand** (serif, 1.1875rem): "Cipherfilm" in the top bar; hidden on phones, the mark remains.
- **Panel title** (sans bold, 1.125rem): section headings inside panels, with a teal icon.
- **Body** (sans 400, 1rem, 1.5): running text, capped at 65ch in cards.
- **Label** (sans 600, 0.9375-1rem): buttons, nav items, form labels.
- **Caption** (sans 400, 0.875rem, muted): hints, storage card, info-panel terms (0.8125rem), scrubber years (0.75rem, tabular numerals).

### On the apps
The same roles carry over at each platform's own base size (see Tokens). Android: page titles in the app bar are the
serif at 24 sp, signed-out titles 26 sp, dialog titles 22 sp, day headings 17 sp and album names 16 sp, all at weight
400; everything else is Material's Roboto scale. Mac: five sans steps (10, 11, 12, 13 body, 15 title) and the serif at
28 (page), 24 (auth), 20 (dialogs, empty states), 19 (brand), 17 (day and section heads), 15 (album and person names).

### Named Rules
**The Serif Is For Time And Place Rule.** Serif is limited to brand name, day headings, page titles, auth card titles and album names. Buttons, labels, menus and body stay sans.

## Layout

App shell is a two-row grid: sticky 56px top bar, then a body of a 232px sidebar plus fluid content. The top bar is three columns aligned to that split: brand, search (max 640px), actions (Upload, avatar). Content is max 1280px with 24px/32px padding and 112px bottom clearance for fixed bars. Signed-out pages use a centered column (main max 1100px) with a 420px card (640px wide variant).

The timeline is a windowed justified-row grid: rows are scaled so every photo keeps its own aspect ratio (clamped 0.4 to 4), 4px gap, target row height 210px (170px under 900px container width, 120px under 520px). A 44px serif day heading precedes each day. A fixed year scrubber on the right edge (44px wide) appears when more than one year exists. Albums are an auto-fill grid of square covers (min 180px, 20px gap). Settings and admin content are capped at 720-760px.

Spacing rhythm is 4/8/12/16/20/24 with 44px as the minimum touch target.

Responsive (max 860px): the sidebar becomes a fixed bottom tab bar (62px plus safe area) with stacked icon and 0.75rem label; storage card, sidebar head and separators hide; top bar brand name and Upload label hide; drop tray and scrubber hide; lightbox info panel becomes an overlay. At 600px, button labels collapse to icons and admin rows stack.

Admin is a separate area: the same sidebar slot holds its own navigation (Users, Defaults, Server, Activity).

## Elevation & Depth

Flat. Depth comes from hairline borders (sand), tonal steps (card white over paper over deep paper), and dashed borders for drop and empty states. Two shadow roles exist and no others.

### Shadow Vocabulary
- **Menu and tray** (`box-shadow: 0 8px 24px rgba(31, 42, 51, 0.14), 0 2px 6px rgba(31, 42, 51, 0.08)`): avatar menu, context menu, drag-to-album tray, the upload window and toasts.
- **Selection bar lift** (`box-shadow: 0 -6px 20px rgba(31, 42, 51, 0.08)`): the fixed bottom selection bar, shipped alongside a top border.

### Named Rules
**The Flat-At-Rest Rule.** Cards, panels, buttons and tiles carry no shadow. If a surface needs separation, give it a rule line or a tonal step.

## Shapes

Small, quiet corners: 6px controls (buttons, inputs, nav items, menu items), 8px cards, panels, accordions, menus, album covers and the drop veil, 4px pills and filmstrip thumbs, 3px photo tiles. Circles are reserved for avatars, faces of people, the empty-state icon disc, tile badges, selection dots and lightbox prev/next. Borders are 1px sand; selection is a 4px inset teal outline; focus is a 3px teal outline with 2px offset (white in the lightbox). Icons are 24px-grid line glyphs with rounded caps at 1.8 stroke.

## Components

### Buttons
- **Shape:** 6px radius, 44px minimum height (40px in the top bar), 18px side padding, weight 600.
- **Primary:** teal fill, white text; hover shifts to Pressed Teal. Used for Upload and the main form action (full-width in forms).
- **Secondary:** card white, teal-ink text, strong sand border; hover fills Teal Wash with a teal border.
- **Danger:** brick fill. **Disabled:** deep paper fill, faint text, not-allowed cursor.
- **Icon button:** 44px square, transparent; hover deep paper. Labels collapse to icons on narrow screens.
- **Link button:** underlined teal text.
- Hover transitions are 0.15s background-color with a decelerating curve, only when reduced motion is not requested.

### Inputs / Fields
- 44px tall, card-white fill, strong sand border, 6px radius, teal caret. Labels above, weight 600. Hints 0.875rem muted.
- **Search:** 40px, deep paper fill with a transparent border and a leading 18px icon; on focus it turns card white with a teal border.
- **Error:** brick-wash block with brick border and bold brick text. **Read-only:** deep paper fill, muted text.

### Cards and Panels
- Card (auth): 8px radius, 1px sand border, card white, 28px/24px padding, serif title. Panel: 20px padding, max 720px. Empty state: dashed strong-sand border on deep paper with a 64px teal-wash icon disc.

### Navigation
- **Sidebar item:** 44px, 6px radius, muted semibold text and 22px icon; hover deep paper; current page uses Teal Wash fill with teal-ink text. Items: Timeline, Favorites, Albums, People (only when the Android or Mac app has indexed faces), Trash. Storage card at the bottom: bordered 8px card, lock icon with "Private to you", and a 5px teal meter.
- **Top bar:** brand (mark plus serif name), search by file name, Upload, avatar button (40px circle, teal ring on hover or open) opening a 280px menu with Account, Admin (admins), Sign out.
- **Phones:** the sidebar becomes a bottom tab bar with the same current-state treatment.
- **Admin:** own sidebar items Users, Defaults, Server, Activity.

### Timeline Tiles
- 3px radius, deep paper placeholder, 12% ink hover veil. Selected tile gets a 4px inset teal outline and a 26px check dot (teal when on). Video tiles carry a 26px dark disc badge (lower left); favorites a filled heart in the same disc (lower right). Unverifiable items show a brick-wash "Couldn't be verified" tile and are never rendered.

### People
- Faces are circles (the one other place circles appear): 120px on the People grid (`.persons`, auto-fill, min 140px), 64px in a person's header, 44px in the lightbox info panel, 1px sand ring, teal ring on hover. Named people use the serif like album names; an unnamed group shows "Add name" in teal-ink sans. Naming is an inline field with Save and Cancel, never a dialog.

### Accordion Cards (Account)
- Native details: 8px radius, sand border (strong when open), 64px summary with teal icon, teal-ink bold title, muted subtitle and a chevron that rotates 180deg over 0.15s. Body padding 4px/16px/16px, forms capped at 420px.

### Lightbox
- Full-screen black dialog. Top row of 44px icon-only buttons (back, favorite, info, download, trash or restore) with the file name and "n of m" beside them; 44px translucent circular prev/next; filmstrip of 52px thumbnails (4px radius, white border on current); info panel 340px in paper and ink (overlay on phones) showing date, file, size, camera, location and the people in the photo.

### Selection Bar, Toasts, Drag Tray, Pills, Meters
- Fixed selection bar in card white with a top rule: Done, the count, Select all or Deselect all, Favorite, Add to album, Download, Move to trash.
- Toasts: the result of an action (moss note with Undo, or a brick error with a dismiss button) floats in a card under the top bar, centred on the content, so it is seen at any scroll position. Notes leave after 6 seconds (12 with Undo); errors stay until dismissed. Drag tray: floating card with the menu shadow and dashed-edge chips that turn teal on hover. Drop veil: teal-wash with a 3px dashed teal border. Pills: 4px radius, status-tinted. Meters: 5px (8px large) rule track with teal fill.

## Do's and Don'ts

### Do:
- **Do** take every color, size, radius and duration from the tokens (`design/tokens/tokens.json`), on all three platforms.
- **Do** use teal (#1f6f6b) as the only accent and Pressed Teal (#17524f) for hover and current text.
- **Do** keep controls at 44px minimum and radii at 6px (controls) and 8px (cards).
- **Do** use the serif only for brand, day headings, page titles, auth titles and album names.
- **Do** separate surfaces with 1px sand rules or paper tone steps.
- **Do** draw icons from the shared 24px, 1.8-stroke inline set in `currentColor`.
- **Do** say plainly when something cannot be verified or recovered; use brick for errors and moss for confirmations.

### Don't:
- **Don't** edit `tokens.css`, `tokens.ts` or `Tokens.swift` by hand, or put literal hex values into a client.
- **Don't** add shadows to cards, buttons or tiles; shadows belong to menus and the drag tray.
- **Don't** introduce a second accent hue or tint the chrome with photo-derived color.
- **Don't** use the serif for buttons, labels, menus or body copy.
- **Don't** use external fonts, CDNs or icon fonts.
- **Don't** draw the padlock mark anywhere beyond the logo, the app icon and the favicon.
