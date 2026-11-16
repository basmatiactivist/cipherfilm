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

## Archive and locked folder

Two folders besides the library, on every app (web, Android, Mac). The rules are pure functions in
`web/src/edit/folders.ts`, shared with the Android app (`@edit/folders`) and mirrored for the Mac in
`mac/Sources/CipherfilmCore/Folders.swift`, with tests on the same cases.

| folder | where the item shows |
|---|---|
| library | everywhere (as before) |
| archive | the Archive view, search, albums, people, the map, favorites; **not** the timeline or On this day |
| locked | only the locked folder: not the timeline, albums, search, people, the map, On this day, favorites, duplicates, Free up space or the trash |

**Stored encrypted.** The folder is a field of the item's encrypted metadata, `archived: true` or `locked: true`
(only `true` counts; locked wins if both were ever written), written like any other change: the next metadata version
through `PUT /api/items/{id}/meta`, every other field kept. Moving back to the library removes the field. The server
sees only that the item's metadata changed (docs/THREAT_MODEL.md), not which folder it went to. Favorites, by
contrast, are a plain flag on the server (server/index.go); the folders deliberately don't follow that.

**Split right after decrypting.** Each app splits the decrypted list once: every view outside the locked folder reads
the list without locked items, so none of them can show one by mistake. An unreadable item can't say where it is and
stays with the library ("couldn't be verified", as before). A stale item (docs/CRYPTO.md, "Metadata version") is not
moved: writing over an older copy would undo a change.

**The locked folder's check.** Every time the folder opens, also while the app is unlocked: the web asks for the
password (checked in the browser by opening the master key with it, as unlocking does; nothing is sent); Android asks
for the fingerprint or the phone's screen lock, and for the password where neither is set up; the Mac asks for Touch
ID, or the password. The folder closes when it is left, when the web tab is hidden, when the app goes to the
background (Android) and when the app locks. This is a gate in the app, not a second key: the item keys and metadata
are opened with the library's master key as before, so anyone who has the unlocked app in hand and gets past the
check sees the folder.

**Nothing on disk.** The locked folder's thumbnails and previews are never written to a cache on disk (the web's
Cache Storage, the Android cache folder and native thumbnail cache, the Mac's caches), and copies stored before an item
was moved in are deleted when it moves. Decrypted pictures are kept in memory only while the folder is open. Sharing,
saving and downloading out of the folder go through the usual paths (the Android outbox, the web download, the Mac
outbox), with their usual clean-up. The decrypted metadata of every item, locked or not, stays in memory while the app
is unlocked, as before: an app has to read it to know an item is locked.

**Albums.** Moving an item into the locked folder doesn't change any album: album views just don't show or count it,
and moving it out shows it there again. (Taking it out of the albums would lose where it was, and the album list would
tell the server which items changed.)

**Deleting from the locked folder** is for good, after a question: the item goes to the trash and out of it at once,
since the trash doesn't show locked items. A locked item trashed by an app that doesn't know the folder is listed in
the locked folder ("in the trash"), to restore or delete.

**Search.** Locked items never show in search results; an index may still hold entries for them (made before the move
or by an app that doesn't know the folder), which are never shown.

**Platform notes.** The Mac also leaves archived items out of its Videos view (part of the main grid there), keeps
locked items out of the export folder (an earlier exported copy is deleted, not moved to the macOS Trash) and still
counts their names and sizes when it checks watched folders for files already uploaded. On Android the native
thumbnail pipeline is never given a locked item's key; one moved into the folder during a session keeps its key in
that pipeline's memory until the next lock (nothing asks for it, and its cached files are deleted). On Android the
actions are under More in the selection bar and ⋮ in the viewer; the web has them under More in the selection bar and
in the right-click menu; the Mac in the context and Photo menus.

**Older apps.** App versions from before the folders ignore the field and show archived and locked items in the
library as usual. Update every app before relying on the locked folder. The public demo can't move items (the server
refuses metadata changes there).

## Limits

- Photos up to 200 MB are edited (they are decoded whole); on Android at most 8192 px on the longer side, so a larger
  edited copy is scaled down. Videos get only a new date and place.
- Faces found before a photo was turned or cropped are cut from the new thumbnail at their old place, so a face's
  small round picture in People can be off for such a photo until it is indexed again.
- The server sees that, and roughly when, an item's metadata, thumbnail or preview was replaced, not what changed
  (docs/THREAT_MODEL.md).
