# Cipherfilm for macOS

A native app (Swift, SwiftUI) for Apple silicon Macs with macOS 15 or later. It does what the Android app does and three
things only a computer that is on all day does well: it keeps a decrypted copy of the library in a folder, uploads new
files from folders it watches, and does the search and face work for the whole library in the background. Source and
build notes: `mac/README.md`.

## What it does

- **Sign in and unlock** against your own server, like the web app. Which server (and which account) is always shown:
  on the sign-in and unlock screens, under the brand in the sidebar, and in the menu bar. The master key lives in
  memory only; after a restart the session stays and only the password (or Touch ID) is asked for again. **Lock**
  (⌃⌘L, the toolbar, the menu bar) forgets the keys and everything decrypted. "Lock when this Mac sleeps or its screen
  locks" (Settings › General, on by default) does the same on its own. Settings › General also shows the app's and the server's
  version.
- **Unlock with Touch ID** (Settings › General, off by default): a P-256 key in the Mac's Secure Enclave, usable only
  after a Touch ID check with the fingerprints enrolled at that moment, locks a copy of the master key (ECDH with a
  one-time key, HKDF-SHA256, ChaCha20-Poly1305 bound to the account). The key never leaves the chip; the account
  folder holds only its wrapped handle and the locked copy (`touchid.json`). Adding a fingerprint makes it unusable
  (the app then asks for the password and turns it off); sign-out deletes it. The password always works.
- **Library:** timeline by capture day in justified rows (the web app's layout), a year scrubber on the right edge and
  "Go to date" (⌘J), favorites, videos, albums, trash with restore and "delete forever". A click opens the
  viewer; a long press starts selecting, and while something is selected a click adds or removes (⌘ and ⇧ work as
  usual, ⌘A selects all, Esc ends it). ⌫ moves the selection to the trash. A person's and an album's page have "Select
  All" for acting on all their photos at once (album, share, save, favorite, trash). The list is decrypted on all
  cores, so a large library opens quickly; the encrypted list is cached, so a restart shows it at once.
- **Shortcuts** (menu Photo; they act on the photo in the viewer, else on the selection): ⇧⌘F favorite, ⌃⌘A add to
  album, ⇧⌘N new album with the selection, ⇧⌘S share, ⇧⌘E save originals, ⌘K photos like this one, ⌘J go to date,
  ⌘⌫ move to trash, ⌘U upload, ⌃⌘L lock, ⌘, settings (also at the bottom of the sidebar). In the viewer also F, I, ⌫,
  ← →, Esc.
- **Taking photos out:** drag them into the Finder, Mail or any app, or right-click › Share…. The originals are
  decrypted into a private folder in the app's caches only when asked for, and that folder is emptied at every lock,
  sign-out and start and after an hour. "Save Original…" writes them where you choose.
- **Viewer:** takes the whole window. The preview at once, the original when it has arrived (HEIC, RAW: whatever
  macOS reads); pinch or double click to zoom, drag to pan; ← →, a filmstrip of the neighbours; quick actions for
  favorite (F), album, share (⌘⇧S), save (⌘S), photos like this one and trash (⌫). The info column (I) lists every
  face found in the photo: named people (a click shows all their photos), "Unknown" faces with "Add Name" right there
  (a name someone already has joins them). Videos play while they download: the
  player asks for byte ranges, and the app answers from the 4 MiB segments, decrypted in memory. Nothing decrypted is
  written to disk.
- **Upload:** drop files or folders on the window (also photos dragged out of the Photos app or a browser: they hand
  over only a temporary copy, which is copied into the app's inbox first and deleted once uploaded), or ⌘U. Four files
  go up at a time, read, encrypted and thumbnailed off the main thread. Encrypted on the Mac, exactly in the web format. The
  uploads panel (click the upload line at the bottom of the sidebar) shows every file with its progress or why it
  failed, with Retry, Retry Failed, Pause and Resume. The queue (file paths only) is saved in the account folder: after
  a quit, restart or lock it goes on once the library is unlocked; a file cut off midway starts again (the server
  drops the unfinished one). The same file is never queued twice.
- **Search and people:** one box for what is in a photo ("dog on the beach"), names, years and months (English and
  German), "videos", "favorites", file names and cameras; "Photos like this one"; people with naming, "same person
  as", "not this person", hiding. The same models, preprocessing, index format and people document as Android
  (docs/SEARCH.md), so the phone and the Mac share one index. A person's page shows their faces: click to pick, then
  drag onto another person or use Move to (also "New Person…"). A face given to someone stays with them even where
  the automatic grouping put it with someone else (on the Mac; the phone still follows only the grouping there).
- **Notifications** when an upload, a watched-folder run, the first export or the first full index finishes: how many,
  never names. Settings › General turns them off.

## Working with the window closed

After the first unlock the app asks whether to stay in the menu bar and open at login (macOS's own login items,
`SMAppService`). With the window closed the Dock icon goes away and a lock icon in the menu bar shows what runs.
Settings › General changes both any time. With "keep running" on, ⌘Q and closing the window leave Cipherfilm in the
menu bar; it ends only with the power button in its menu-bar panel (and when you log out or shut down).

Indexing is resumable: each photo's result is stored on the server as soon as it is made, so after a quit, restart or
lock only the one or two photos that were in progress are looked at again.

What needs what:

| Work | Needs | While locked |
|---|---|---|
| Watched folders | the session (cookie) and the account's public key, pinned when turned on | keeps working |
| Continuous export | the master key (it decrypts) | waits for unlock |
| Search indexing | the master key (it decrypts previews) | waits for unlock; files from watched folders are indexed from the file at upload |

After a restart (or Open at Login) the library is locked until you unlock it once. There is deliberately no
"remember the password"; with Touch ID unlock that is one touch.

## Export

Settings › Export, choose an empty folder (or one this account exported to before; a hidden `.cipherfilm-export` file
marks it). The folder gets a decrypted copy of the library, dated like the photos.

- **Keep up to date** (on by default): the export runs on its own whenever the library is unlocked, also with the
  window closed: new items from any device arrive within a couple of minutes (the library is refreshed every two
  minutes and after every upload), deleted ones leave. Off: nothing happens until **Export Now**.
- **Folders:** by year and month (`<year>/<year-month>/<name>`), or by album (`<album>/<name>`; a photo in several
  albums goes into the first one only, photos in no album into `Not in an album/<year>/<year-month>/`).
- **What:** everything, favorites only, or chosen albums.

No duplicates, by design:

- each item is written once; the app remembers what it wrote and where (`export.json`);
- the same photo uploaded twice (same name and size) becomes one file;
- a file already at the right place with the same name and size (a folder exported to before, a lost list) is adopted,
  not copied again; there are no "name (2)" copies of the same photo. Two different photos with the same name in one
  folder are the only reason for a "(2)";
- changing the folders (by month ⇄ by album, an album change) moves the existing files instead of writing new ones.

How changes are handled, so that the export can never destroy anything you did not delete yourself:

- **Moved to the trash or deleted in the library, or no longer chosen:** the exported copy is moved to the **macOS
  Trash**, where you can put it back, but only if it is still unchanged at its place (same size and modification
  date as written) and no other item shares it. A copy you edited stays. This can be turned off.
- **Restored from the trash:** exported again.
- **Renamed, moved or deleted by you inside the folder:** left as it is. The app does not write it again by itself, so
  reorganising the folder is safe. "Export Missing Files Again" restores what is gone.
- **Nothing in the folder goes back into the library.** The export is one way. To upload, use watched folders
  (pointing one at the export folder would only find duplicates, which are skipped).
- **Names in the library don't change** (no client can rename an item), so there are no renames to follow from that
  side.
- **Signing out** asks whether the exported copies should go to the Trash too (unchanged files only). By default they
  stay: they are your files in your folder.

The exported files are not encrypted. Anyone who can read that folder (or its backups) can see the photos. Put it on
an encrypted volume (FileVault is on by default on modern Macs) if that matters. While the library is locked the
export waits; with Touch ID unlock, one touch after a restart is enough.

## Watched folders

Settings › Watched Folders: add folders and choose whether files already in them count ("Only files added from now
on") or are uploaded too. New photos and videos are uploaded seconds after they appear (FSEvents), and every ten
minutes a full pass catches anything missed. A file that is still being written waits for the next pass.

Like the Android backup, this needs no master key: each new item key is sealed to the account's public key (format in
docs/CRYPTO.md §3, version 2), pinned when the feature is turned on after checking it against the private key. So it
works while the library is locked, and it can add photos but not read any. Skipped: files the library already has
(same name and size, refreshed whenever the library is unlocked), files it uploaded before, hidden files, and the
insides of packages (such as a Photos library). A file that fails three times is skipped and listed in Settings.

## Speed

- **Thumbnails** come in batches: the tiles on screen ask within a few milliseconds of each other and get up to 100
  thumbnails in one request (`POST /api/items/thumbs`; 80 took 37 ms on the test server), decoded off the main
  thread. The newest 400 are fetched ahead as soon as the library opens, and the encrypted thumbnails stay in the cache
  folder, so a restart shows them without the network. Against a server without the batch endpoint the app falls back
  to one request each.
- **Search indexing:** the models take about 65 ms a photo on an M-series Mac. Six photos are in flight at once, since
  downloading the preview is the slow part; people and open search results are worked out again at most every few
  seconds while it runs, not after every photo. It runs on battery too (Settings › Search turns that off).

## Search on the Mac

Off until turned on (the question after the first unlock, or Settings › Search & People). Then the Mac downloads the
models once from Hugging Face, at the pinned URLs in `server/models.json` (about 250 MB, checked against the same sizes and
SHA-256 values as the phone; no cookie or other app header goes along, docs/MODELS.md), fetches the entries
other devices made, and indexes every photo and video that has none, six at a time at low priority, also on battery
(Settings › Search can limit it to power). Entries are sealed to the account's public key and stored on the
server, so each photo is analysed once for all devices. The download has no overall time limit (a slow tailnet relay
may bring a few hundred KB/s); a minute without a byte counts as a drop. Each file goes to `<name>.part` first and
a drop, or quitting, resumes it with HTTP Range; drops and stalls are retried with backoff (2 s up to a minute) until
the download is done, never given up. Search & People and the sidebar show the bytes, the speed and the time left, or
why it is waiting ("The connection to Hugging Face dropped. Trying again in 4 s").

Errors say what happened, not a generic "Can't connect": a request that pauses for a minute is "The server is slow to
answer", a dropped connection, no network, a server that refuses the connection, an unknown name, an untrusted
certificate, or the status the server or a proxy answered ("The server answered 404 (not found; the server may be
older than this app)"). Search adds the step that failed ("Fetching the index from the server: …") and tries again by
itself. JSON requests allow a one-minute pause (it was 20 s): over a relayed tailnet a model download can hold a small
request back that long, which read as "Can't connect to the server" while the server was fine. Where an admin allowed explicit search, turning search on asks for the
model first, so only that one is downloaded. Every size the app shows (the first-unlock question, the model choice,
Settings, the switch to and from explicit search) is worked out from the files missing on this Mac for that model:
about 248 MB for MobileCLIP with faces, 647 MB for LAION with faces, 66 MB or 256 MB for a Mac that only reads (text
model and tokenizer); "already on this Mac" when nothing is missing.

The models run with ONNX Runtime on the CPU in fp32, as on the phone (fp16 is unusable for MobileCLIP on ARM). The
preprocessing follows `Vision.kt` step by step (JPEG decoded as stored, halving bilinear downscales, centre crop for
MobileCLIP, letterbox and BGR for YuNet, the least-squares similarity warp onto ArcFace's points for SFace). Checked
against entries the Android app wrote for the same photos on the test server: image vectors agree with cosine ≥ 0.998
(23 photos and videos), every face is found with the same box (±0.005), and face vectors agree with cosine 0.95–0.997
(the same person is above 0.5). `MODEL_TAG` is the same, so neither device redoes the other's work.

**One device indexes** (docs/SEARCH.md, 1.9.0): per account one device computes the entries, the others only read
them. The Mac sends `X-CF-Device: <computer name> (Mac app)` with every request (the device list shows it; ASCII only, other characters of the name are left out) and reads
`session_id` and `indexer` from `/api/me`: it indexes when `indexer` is empty or this session, otherwise it only reads.
A reading Mac keeps just the model's text encoder and the tokenizer (its image and face models are deleted), computes
nothing (also not for files from watched folders), and fetches what the indexing device adds about once a minute. A
write refused with 409 `not_indexer` turns indexing off at once. Settings › Search & People shows "This Mac indexes
your photos" or "Indexed by <device>, last seen …" with "Index on This Mac Instead" (`PUT /api/me/indexer`, then the
image models are downloaded and the library indexed); turning search off gives the role up (`DELETE /api/me/indexer`).
Entries are read per model family (`GET /api/index?model=mcs2` or `laionb32`) and cached per family
(`index-<family>.json`), so a switch back doesn't fetch the other model's entries again.

Search by what is in a photo ranks like Immich's smart search, for both models: every photo with an entry from the
active model, best match first, no cut-off, shown 200 at a time (more as the end of the results comes into view).
People, years, months, favorites and videos in the query narrow that ranking; a file name or camera containing the
words comes first.

**Explicit search** (docs/SEARCH.md): shown in Settings › Search & People only to a person an admin allowed it
(`user.nsfw`). Turning it on asks first, saves `explicit: true` in the encrypted people document (so the phone and
other devices switch too), downloads LAION's ViT-B/32 (about 600 MB; `nsfw-*` files, fetched with the session cookie)
and indexes the library again; turning it off goes back to MobileCLIP, whose entries the indexing device kept current.
Each switch deletes the other model's files before downloading the chosen one (the tokenizer and the face models are
shared and stay; a Mac that indexes with LAION keeps MobileCLIP's image model), and clears the index in memory. While
explicit search is on, the indexing Mac stores two entries per photo, LAION's and MobileCLIP's, from one look at it
(faces found once), so devices without explicit search find a complete index; a MobileCLIP entry that is missing (or
was deleted on the server, which `count` on the index list's first page shows) is made again, with the faces of the
photo's LAION entry. Turning explicit search off deletes LAION's entries on the server
(`DELETE /api/index?model=laionb32`, after the people document is saved) and the cached copy here; turning it on
deletes nothing. Entries
made with the other model are made again, and until then their image vectors stay out of search (their faces are
still used). The Mac checks the choice and the permission about once a minute while idle, so a change made on another
device or by an admin takes effect without a restart; files from watched folders use the choice last seen. LAION's
image preprocessing is Pillow's bicubic resize (shortest side 224, centre crop, CLIP mean and std), as in its Python
reference; text goes in as int32. Every entry is stored with its model tag in the clear (`model`), which the server
requires where explicit search is allowed; a server from before that gets the entry without it.
Checked against `mac/scripts/laion-reference.py` (ONNX Runtime 1.31.1): text vectors cosine 1.0, image vectors ≥ 0.990
on 8 images of different sizes and shapes (the lowest is the difference between Apple's and Pillow's JPEG decoders;
the same picture decoded by both gives that cosine in Python alone). About 50 ms a photo with faces on an M-series Mac.

## Sign-out

Deletes everything the Mac keeps for the account: settings, the export's and watched folders' bookkeeping, the
encrypted cache (item list, thumbnails, previews, index entries) and the session cookie. The search models stay; they
hold nothing of anyone. Exported copies stay unless you choose otherwise (see above).

The same happens when the server ends the session (signed out from another device in Account › Devices, or expired):
the first request that gets 401 forgets the account here, and so does the next start if it happened while the app
was closed. Exported copies stay.

## Deleting the account

Settings › General › Delete Account…: after the password the server deletes the account with all its photos, videos,
albums, people and search data and signs out every device; this Mac then forgets everything it keeps for the account,
as at sign-out. Exported copies stay. The only active administrator must make someone else an administrator first.

## Where things are

- `~/Library/Application Support/app.cipherfilm.mac/accounts/<user id>/`: settings, `export.json`, `watch.json`,
  `known.json` (name-and-size fingerprints, BLAKE2b, like Android's).
- `~/Library/Application Support/app.cipherfilm.mac/models/`: the search models.
- `~/Library/Caches/app.cipherfilm.mac/cf-ct/<user id>/`: the server's ciphertext (opens only with the master key).
- `~/Library/HTTPStorages/app.cipherfilm.mac`: the session cookie.

## Not yet

- Signed and notarised builds: CI builds an unsigned (ad hoc) app until a Developer ID certificate is set up as a
  secret; Gatekeeper asks before opening it.
- Apple silicon only: Microsoft ships ONNX Runtime for macOS on arm64 only.
- Sharing, editing, a map view.
