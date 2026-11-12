# Editing

Simple, non-destructive editing: turn a photo by quarter turns, crop it (free or in a common shape), and change when and
where a photo or video was taken. Available in the web app (lightbox › Edit, key `E`) and the Android app (viewer ›
Edit). The Mac app shows edits made elsewhere; it doesn't edit. The public demo hides editing (and the server refuses
it).

## The original is never changed

The encrypted original on the server stays exactly as uploaded. What was done is stored in the item's encrypted
metadata (`meta_enc`), which only the person's devices can read, and goes up through the same
`PUT /api/items/{id}/meta` as every other metadata change; the other devices pick it up with the change list.

| field | what it holds |
|---|---|
| `edit` | `{ rot, crop: { x, y, w, h }, v }`: turned clockwise by `rot` (0, 90, 180, 270), then cropped to the fraction `crop` (0..1) of the turned picture; `v` names the thumbnail and preview made for it |
| `orig` | `{ capture_ts?, gps? }`: the date, and the place (`null` if there was none), before the person first changed them |
| `capture_ts`, `gps` | changed in place, so every app (also older ones) sorts the timeline and draws the map with the new values |

"Revert to original" puts `capture_ts` and `gps` back from `orig`, drops `edit` and `orig`, and makes the thumbnail
and preview from the original again. Every field is optional; older apps ignore what they don't know (checked for the
web, Android and Mac decoders and `tools/decrypt`). Whatever a device reads is checked again (`normEdit`, `normOrig`):
a nonsense edit becomes "no edit", never an unreadable item.

The rules (turning a crop with the picture, the crop in the original's pixels, the crop shapes, dragging the crop
frame) are pure functions in `web/src/edit/edit.ts`, shared with the Android app (`@edit/edit`) and mirrored for the
Mac in `mac/Sources/CipherfilmCore/PictureEdit.swift`; all three have unit tests on the same numbers.

## New pictures for a turned or cropped photo

After a turn or crop the device that edits downloads and decrypts the original, draws the edited picture from it and
stores a new encrypted thumbnail (640 px) and preview (2048 px) under the item's key, through
`PUT /api/items/{id}/replace/thumb` and `/replace/preview` (only the owner's finished items that are not in the trash;
the same size limits as at upload; the difference counts toward the storage limit). The pictures go up before the
metadata, so a device that sees the new edit finds them. Each device caches pictures by item and `edit.v`, so a new
version is fetched once and old ones are never shown for it.

The viewers show the edit: the web lightbox and the Android viewer show the preview (made with the edit); the Mac
viewer, which shows the original at full size, draws the original turned and cropped.

On Android the original is decrypted for this into the app's private outbox folder (as for sharing), removed right
after, and with the outbox at every lock (and by the native clean-up job if the app is killed).

## Dates and places

The date and time are typed in this device's time zone (as cameras write EXIF dates). The place is picked by name from
the place file inside the apps (towns of 1,000 people and more; nothing is sent anywhere to search), or, when the map
is turned on, by tapping or clicking the map; it can also be removed. A changed date moves the item in the timeline,
a changed place moves it on the map and in place search, here and on the other devices. A photo or video whose place
the person removed or set is left alone by the apps that add missing locations afterwards (web and Android
`relocate`; older app versions don't know this and may add a removed location back from the file).

## Downloads, shares and exports

- **Web:** an edited photo downloads as edited ("name (edited).jpg", drawn at full size in the browser); the original
  is in the details ("Download original", `Shift+D`). ZIP downloads of several items contain the originals.
- **Android:** Share and Save give the edited photo, also for a selection; the details have "Share original" and "Save
  original".
- **A photo whose date or place changed** (not turned or cropped) leaves web and Android the same way, with the date and
  place as last set: a JPEG keeps its own pixels (not drawn again, same name) with its metadata replaced: every Exif,
  XMP, IPTC and comment block goes, one Exif block with the date, the place (none if removed) and its orientation is
  written, and nothing after the picture's end is kept (a motion photo's video). Another format (HEIC, PNG) is drawn
  anew as a JPEG, as an edited copy. "Download original", "Share original" and "Save original" give the file as
  uploaded. Videos keep their place in the file (it is not rewritten).
- **Mac:** Save Original, sharing and the export folder keep the originals as uploaded; the edit is not applied to
  exported files. `tools/decrypt` exports originals too (filed under the date as last set).

An edited copy is a new JPEG: its EXIF holds only the date and place as last set (and orientation "upright"); nothing
else of the original's EXIF (camera, serial numbers) is copied.

## Limits

- Photos up to 200 MB are edited (they are decoded whole); on Android at most 8192 px on the longer side, so a larger
  edited copy is scaled down. Videos get only a new date and place.
- Faces found before a photo was turned or cropped are cut from the new thumbnail at their old place, so a face's
  small round picture in People can be off for such a photo until it is indexed again.
- The server sees that, and roughly when, an item's metadata, thumbnail or preview was replaced, not what changed
  (docs/THREAT_MODEL.md).
