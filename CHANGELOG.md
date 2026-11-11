# Changelog

All notable changes to Cipherfilm are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The release workflow copies the section of the tagged
version into the GitHub release notes, so a release cannot be published without an entry here.

## [Unreleased]

### Added
- Web, Android, Mac: before the search models are downloaded from Hugging Face, the app asks: what, how big, from
  whom and what Hugging Face sees. Turning search off deletes them; the settings show when they were downloaded.
- Android and Mac: the admin area is in the apps too (Account › Administration on Android, Settings › Administration
  on the Mac): people and their usage, invites to share, storage limits, roles, disabling and deleting accounts,
  turning off someone's two-step sign-in, explicit search, the server's state and the activity log.
- Server: a ready-made private setup in your tailnet (Tailscale, your own name, Kopia backups, optional Portainer)
  in `deploy/tailnet`, the same one the project's own server runs; guide in docs/TAILNET.md.
- Android: Account › "Allow screenshots" lets this phone take screenshots and screen recordings of the app and show
  it in the recent apps. Off by default, so the app stays blocked as before; the change applies at once.
### Fixed
- Android: the search index kept on the phone (both the standard and the explicit model's) was deleted with the
  cleanup of cached pictures after every library load, so search had to fetch and open the whole index again at each
  start. Both copies now stay; phones that lost them fetch them again once.
- Android: a language changed in Android's settings (the phone's, or the app's own from Android 13) applies as soon as
  you come back to the app, without restarting it; the open screens stay.
- Mac: videos with the iPhone's location key in a meta box inside udta (as ffmpeg writes it) uploaded without
  their place; the Mac app now reads it there too, like the web app and the upload tool.

### Changed
- Albums update incrementally on every platform: after the first load, a change fetches only the albums that changed
  and which were deleted (`GET /api/albums?since=`), not every album again.
- Two-step sign-in: turn on codes from an authenticator app under Account (web, Android, Mac); a new sign-in then
  asks for a code or one of ten one-time recovery codes. Unlocking a device that is already signed in doesn't. An
  admin can turn it off for someone who lost their phone (Admin › Users, or `reset-2fa` on the server).
- Devices under Account on Android and the Mac too (the web had it): see where you're signed in and sign out one or
  all other devices. Your other devices show a notice when a new one signs in, when an admin turned off two-step
  sign-in, and, with two-step sign-in on, when your password was used for a sign-in that wasn't finished.
- "On this day": above Photos, the web, Android and Mac apps show a card for each earlier year with photos from
  around today's date. Worked out on the device; the server learns nothing. Turn it off in Account (Settings on Mac).
- Web and Android: "Duplicates and similar photos" finds photos uploaded more than once and bursts of nearly the same
  shot, on your device, suggests which to keep and moves the rest to the trash (restorable for 30 days).
- Editing on the web and Android: turn photos, crop them (free or in common shapes), and change when and where a photo
  or video was taken (search a town, or pick the spot on the map). The original is never changed; downloads, shares and
  saves give the edited photo with its date and place, the original stays one click away, and "Revert to original"
  brings everything back. The Mac shows edits made elsewhere.
- Server: `PUT /api/items/{id}/replace/thumb` and `/replace/preview` store the new encrypted pictures of an edited
  photo (owner only, counted toward the storage limit; refused for the public demo).

## [2.6.1] - 2026-11-10

Photos and videos keep where they were taken, however they are uploaded, and what arrived without it gets it.

### Fixed
- Android: photos added with the Upload button arrived without their location (Android's photo picker hands out
  copies without it), so they never showed on the map. The app now reads the original, asking first for "where photos
  were taken" (Android grants it without a dialog), and keeps the photo's real file name instead of its number.
- Android: photos backed up without that permission arrived without their location. While the map is on, photos and
  videos this phone uploaded without their location get it from the original still on the phone, once the
  permission is there (the map asks for it once).
- Videos got no location in any app. The web, Android and Mac apps and the upload tool now read it from the video
  (udta/©xyz as Android and most cameras write it, and the iPhone's location key), and with the map on the web app
  adds it to videos uploaded before, reading only the video's header boxes from the encrypted original.
- Android: a single photo on the map showed an empty circle instead of its picture.
- Android: EXIF is read through the file itself, so HEIC photos keep their date and place too.

### Added
- Server: `PUT /api/items/{id}/meta` lets an app replace a finished item's encrypted details (for the location added
  afterwards). The server can't read them, as at upload; the change reaches the other devices like any other, and the
  public demo refuses it.

## [2.6.0] - 2026-11-09

Your photos on a map, in every app: where they were taken, found by place, with the locations end-to-end encrypted.

### Added
- Map: photos where they were taken, as clustered thumbnails on a world map, in the web, Android and Mac apps. A
  cluster opens closer; the panel beside (or below) the map lists the photos in view and follows every zoom and move,
  titled with what their places share ("Zürich, Switzerland"; "France, Switzerland and 3 more").
- A photo's details show the place's name and, with the map on, a small map of its spot at district level; with the
  map off they offer "Show on the map".
- Search by place: "zurich", "Zürich", "switzerland", "japan", "new york". On Android countries are in the app's
  language ("Zürich, Schweiz") and found by either name.
- Everything about locations happens on the device: the coordinates stay end-to-end encrypted, and place names come
  from a GeoNames file bundled with the apps (every place with at least 1,000 inhabitants, a big city counting as far
  as it reaches, so the Eiffel Tower is in Paris).
- The map is off until each person turns it on, after a short explanation of what the map server sees; Account › Map
  (Settings › General › Map on the Mac) turns it off again. If the server later names another map server, every device
  asks again. The base map is OpenFreeMap (VersaTiles as fallback), which
  sees the device's IP address and the map areas viewed, never a photo or its coordinates; the map opens on the whole
  world and never moves to the photos by itself.
- `MAP_STYLE` on the server: your own map server's styles, or `off` for no map (place names and place search keep
  working). docs/MAP.md explains setting up your own map tiles.

### Changed
- The place-name file goes out gzip-compressed (2.2 MB instead of 3.8 MB on first use).

### Security
- Web, Android and Mac take an item's kind (photo, video) from its encrypted metadata, no longer from the server's
  plain field, so a malicious server can't route a photo's bytes to the video player or the image decoder.
- Web: a tab stays unlocked only across a real reload; a reopened tab, a restored browser session, the address typed
  again or a phone browser reloading a tab it had dropped ask for the password (docs/CRYPTO.md). A page brought back from the browser's back/forward cache starts again and checks the session.
- Android: the map doesn't stay on screen when the app locks, and the map's cache of loaded map images is cleared at
  lock, sign-out and when the map is turned off.
- Mac: Share and Save stop at lock and sign-out; copies of files dropped from other apps are deleted when their upload
  is cancelled or removed and at sign-out; thumbnails and search entries still being opened at lock don't stay in
  memory.
- Mac: the Touch ID key's handle is in the login keychain, readable only by the app (it was a file other programs of
  the same user could read). macOS asks once for the Mac's password after an update until the app is signed by Apple.
- Updates of crypto and storage libraries (libsodium, x/crypto, JNA, SQLite) are never merged automatically.
- The web app's crypto is tested against the same committed vectors as the decrypt tool and the Mac app.
- Server image: the package manager, zlib and OpenSSL are no longer in it (only the package manager and busybox's
  https client used them); this clears zlib's CVE-2026-4738 and keeps such alerts out. The shell for the `cipherfilm`
  console command stays.

## [2.5.1] - 2026-11-09

The server commands work in any container console, such as Portainer's: `cipherfilm status`.

### Changed
- Server image: Alpine instead of distroless, so the container has a shell. The server commands now work in
  Portainer's (or any) container console: open it with `/bin/sh` and type `cipherfilm status` (docs/SERVER-COMMANDS.md).
  `cipherfilm` on its own lists the commands. The app still runs as the same unprivileged user (compose.yaml keeps it
  read-only, without capabilities); nothing is added from the package index, so the image is the pinned base plus the app.
- Server commands refuse to run as root on data the server owns as its own user (a console opened as root): the files
  they create would lock the server out. Typing `/app` in the console no longer gets as far as touching the data: a
  second server stops at the busy port first.

### Security
- E-mail addresses with control characters are refused (invites, sign-up, sign-in), so none can rewrite what the
  server commands print in an operator's terminal.

## [2.5.0] - 2026-11-09

Security fixes from an audit of the whole product, limits for the public demo, and the Android build is signed apart
from where it is built.

### Security
- Android: libraries other modules bring along are raised past known security fixes: Gson 2.11.0 (from 2.8.6, in
  Expo's core), commons-io 2.18.0 (from 1.4, in Expo's file system) and Guava 33.7.2 (from 33.3.1, in Media3 and
  Glide). The app's Gradle libraries are now reported to GitHub's dependency graph, so Dependabot raises alerts for
  them too (only what goes into the app, not the build tools).
- The published server image is scanned with Trivy weekly and after each release; findings appear under the
  repository's Security › Code scanning.
- Server: a list page gives its database connection back before it is sent, so slow or many large lists of one
  account can't hold up everyone else; incremental lists (`?since`) read only as many rows as one page carries.
- Server: a part sent again while it is already stored needs room in the storage limit while it is received.
- Server: the public demo login gets no device cookie, so one visitor's wrong passwords can't block the others.
- Server: the public demo login is limited per visitor (address): requests (10 a second on average, 300 at once),
  sign-ins (30 an hour, counted even when they succeed) and list requests (one visitor can't hold the account's
  turns). It gets no search models through the server, and the server passes models through to older apps only two
  at a time. Other accounts on the same server, an app-store reviewer's included, are not limited this way.
- Server: request headers are capped at 64 KB.
- Server: deleting an account also removes its invite and its mentions in the activity log; only the entry of the
  deletion itself keeps the e-mail address, as the delete-account page says.
- Restore: what happened to the accounts after the backup stays as it is: changed passwords and recovery keys,
  roles, disabled and deleted accounts (they stay disabled), withdrawn invites and the activity log. This also holds
  for the demo server's daily reset. `restore.sh` and `fotocrypt.sh restore` refuse archives with hard links.
- Web: signing out (or in) in one tab ends the session in the browser's other tabs too; they forget their keys and
  the decrypted library at once.
- Mac: an item id from the server becomes a folder name only after it passed the id check, and items that can't be
  read aren't shared or dragged out; a watched-folder pass stopped by signing out writes nothing more for that account.
  The live-update stream, dates and duplicate list entries from the server are handled without crashing.
- Android: a file that makes the phone's decoder hang no longer holds up the backup for good: after a while it
  counts as failed and the backup goes on.
- Releases publish only the exact files their build jobs made (checked by checksum), the Android build runs no npm
  install scripts, and it is built without the signing keys: a separate job signs it, runs none of the build's code
  and does so only for commits on master.

### Fixed
- Android: saving a video says it went to Movies › Cipherfilm (it said Pictures).
- Web and Android: the library appears once the first screen's photos are decoded, never as empty tiles.
- Android: Report a problem opens in the browser (the GitHub app dropped the prefilled form).
- Android: a video whose file says "no date" (MP4 date 0, written by some apps and tools) is no longer filed under
  January 1, 1904; it gets the upload time, like a photo without a date.
- Docs: the threat model says the search models come from Hugging Face.
- Apps, README and store texts: Hugging Face is named as the trademark of Hugging Face, Inc., with whom Cipherfilm
  is not affiliated.

## [2.4.1] - 2026-11-08

The Android app turns with the phone and fills tablets.

### Changed
- Android: the app turns with the phone and fills tablets and foldables (it was locked to portrait; from Android 16
  large screens ignore that lock). The photo viewer stays on the same photo when the phone turns and measures the
  system bars again.

## [2.4.0] - 2026-11-08

"Report a problem" in every app, and fixes for naming people, the German privacy policy and reloads on the web.

### Added
- "Report a problem" in every app (Android: Account, under About; web: the account menu; Mac: the Help menu and
  Settings). It opens GitHub's issue form in the browser and, if you agree, fills in this device's details: the app
  version, the system and model (or browser and system), and the server's version. The dialog shows exactly that line
  first; "Without details" opens the empty form. The app sends nothing itself, and never the server address, e-mail,
  photos or names. Android has the dialog in German too.
- Issue forms on GitHub for problems, ideas and questions; security reports go to private vulnerability reporting.

### Fixed
- Android: naming a person said "No photos of this person" until the People list was opened again (with a big
  library the faces are grouped again for a while after naming); the photos now stay, with the new name.
- Android: the privacy policy opens in German (cipherfilm.app/de/datenschutz) when the app speaks German.
- Android: the server's notice for the public demo ("changes are turned off") is in the app's language.
- Web: a reload right after signing in or unlocking could ask for the password again; the tab now finishes
  keeping the key for reloads before it shows the library.

## [2.3.0] - 2026-11-08

The Android app in German, a full-screen photo view, and fixes for backup and search found on a real phone.

### Added
- Android: the app in German when the phone (or Android's per-app language) is set to German; everything else stays
  English. Dates and numbers follow the language. Search words for what is in a photo stay English (the on-device
  models understand English); names, dates and file names work in German too.
- Android: a tap on a photo or video hides the app's bars and Android's status and navigation bars, as in other
  gallery apps; another tap brings them back. Swiping keeps the state; leaving the viewer always restores the bars.
- Android: the Backup screen shows the upload speed (over the last few seconds, across the files under way), how many
  are left and a progress bar while a backup runs.

### Changed
- Android: clearer wording when setting up backup on a phone that never backed up: "Only new photos and videos from
  now on" or "Also the N photos and videos already in these folders" (ones already in the library are skipped). No
  more "N aren't in Cipherfilm" and "Back up these too" right after setup.
- Android: the backup is faster on real phones. Reading photos, thumbnails and EXIF ran on the one thread that also
  starts every request and reads every response, so the three files under way waited on each other's thumbnails; it
  has threads of its own now. A backup without the upload service (Google Play's automatic runs) indexes the new files
  for search after the uploads instead of between them, and the open Backup screen no longer reloads the whole photo
  library at every step of a run.

- Android: the loading badge in the photo viewer sits small in the bottom-left corner instead of large over the photo,
  and shows while a video buffers.
- Android: search jobs (model downloads, checking them, opening the models, looking at photos, the index) run on
  threads of their own. They held the one thread every request goes through, so the app stalled while the phone
  indexed. Indexing starts right after the models are downloaded, new photos join a running index instead of
  restarting it, and the search settings open at once while indexing runs.

### Fixed
- Android: the Albums tab showed an empty page while albums loaded; it shows the loading badge now, and so do an album,
  a person and search results while they load (an album or person that no longer exists says so instead of loading
  forever).
- Android: decrypted copies made for sharing are deleted 15 minutes later even when Android ended the app meanwhile,
  and decoded pictures leave the image memory cache when the app locks.
- Android: the backup notification's "Backing up n of m" no longer jumps back (23, 20, 23, ...) while several files
  upload at once; it counts what the run is done with and shows the speed.
- Android: "Run in the background" shows "Allowed" when Android's battery setting for Cipherfilm is "Optimized" (on
  Android 14 and later: "Allow background usage" on), and offers to open the settings only when it is "Restricted".
  Search settings use the same check. Notifications show as off when the backup's own notification channel is off.

## [2.2.0] - 2026-11-07

Live updates across devices, faster Android backups, a loading badge everywhere, and search that stays complete with
explicit search on. The database gets a change counter per account at the first start (automatic, nothing to do).

### Added
- Live updates: a photo uploaded on the phone shows in the web app and the Mac app within a second or two, without a
  reload, and so do deletes, the trash, restores, favorites, albums and names of people. The server keeps a change
  counter per account and pings that account's other devices over `GET /api/events` (Server-Sent Events) with only
  the counter and which lists changed; they load those lists through the usual API. The Android app listens while it
  is on screen and unlocked, never in the background. Streams end with their session (sign-out, signed out from
  another device, password change, disabled or deleted account) and are limited per session, account and server.
  Behind nginx, turn off buffering for `/api/events` (docs/SELF-HOSTING.md); a proxy that buffers it anyway makes the
  apps load the lists every 15 seconds instead.
- Live updates load only what changed. Before, every ping made each device fetch the whole library again (and the
  Mac decrypt all of it); during a 200-photo backup from the phone that was the whole list every second or two. Now
  `GET /api/items?since=<cursor>` (and `/api/trash?since=`) answers with the records created or changed after the
  cursor, the ids of those that left the list, and the next cursor, page by page; the apps fetch and decrypt only
  those and merge them by id. The whole lists hand out the cursor with their first page; `?after` paging and the whole
  list work as before for older apps, and newer apps fall back to them against an older server. Measured with 3,000
  synthetic items: the whole list is about 2.1 MB in two requests; one favorite on another device is 0.8 kB with one
  record; 200 new photos are 81 kB with 200 records. Android also keeps the cursor with its cached list, so the next
  start asks only for what changed; the Mac does the same after unlocking.
  The server numbers every change per account (`items.rev`, `users.items_rev`, set by database triggers in the
  change's own transaction) and keeps a tombstone for each deleted item for 30 days. A cursor older than the kept
  tombstones, from before a restore (`restore.sh` starts a new epoch), or otherwise unknown, gets `"reset": true` and
  the app loads the whole list once. The migration runs at the first start; nothing to do.
  Even with a cursor, each app loads the whole list at least once a day.
- A loading badge on the web, Android and the Mac, so a wait is always visible: the Cipherfilm mark on a round seal
  whose edge is a turning teal ring; while it waits, tiles pass over the photo in the mark and the padlock closes, as in
  the website's picture. It shows large with what is happening while the app starts, the library, albums, favorites,
  trash, people and search load, and while a photo decrypts or a video is prepared; small in busy buttons ("Signing
  in…", "Saving…") and status lines. It follows light and dark mode, appears only when a wait is noticeable and, with
  reduced motion, only fades. Upload and download progress bars are unchanged.
- `APP_BIND`: the address the app listens on (default `127.0.0.1`), so a reverse proxy that runs in a Docker container
  can reach it (the Docker bridge's address).

### Changed
- Android: automatic backup uploads three files at once, and checks which account the session belongs to every few
  files instead of before and after each one, so many small photos wait far less on a slow link. A folder's place
  still moves only past files that are done, and nothing counts as backed up before a check confirms it went to the
  right account.
- Web: lock and sign-out overwrite the master key's bytes, not only drop the reference.
- CI runs on branches only; a release tag is checked (identity included) and built by the release workflow alone.
- Dependabot works again: GitHub had rejected the whole `.github/dependabot.yml` (per-semver cooldowns aren't supported
  for docker, docker-compose and GitHub Actions), so no version update ran since the repository was created. The
  identity check accepts GitHub's bot noreply addresses (`…+dependabot[bot]@users.noreply.github.com`) and
  Dependabot's sign-off. Playwright's browser image for the e2e suite follows its npm package (one version to bump); the Mac app's
  Swift package is checked by hand (Dependabot can't resolve it without the downloaded ONNX Runtime).

### Fixed
- Search and people were empty on devices without explicit search (the Android app from Google Play, older apps,
  devices of people not allowed it) once an account turned explicit search on: switching deleted the standard
  (MobileCLIP) index and only the explicit one was built. Now the indexing device (Android, Mac) keeps both current
  while explicit search is on: each photo is looked at once with both image models, faces are found once, and two
  entries are stored. Turning explicit search on deletes nothing; turning it off still deletes the explicit index.
  Accounts that lost the standard index get it back: the indexing device notices the missing entries (the index
  list now counts them on its first page) and makes only those, with the faces it already found. Costs one more image
  model pass per photo, and MobileCLIP's image model (143 MB) on the indexing device, while explicit search is on.
- Android: a backup run that dies between finishing uploads and their account check (they are checked in batches)
  no longer uploads those files again: they are noted on the phone and confirmed by the next run.
- Web: albums no longer say "No albums yet" (and an album "no longer exists") while they are still loading, and
  favorites no longer say "No favorites yet" while the library loads.

## [2.1.8] - 2026-11-07

Simpler self-hosting, and the privacy policy inside the Android app.

### Added
- Android: a "Privacy policy" link on the connect screen and under Account (Google Play asks for it inside the app).

### Changed
- Android, Google Play build: automatic backups no longer run in the foreground service; only "Back up now" and shares
  do (Google Play's rules for data transfers). Automatic runs work in WorkManager's time and continue in the next run;
  a video too large to finish in one waits for "Back up now" (a notification and the Backup screen say so) instead of
  starting over every run, and the photos after it go on. The GitHub build is unchanged.
- `compose.yaml` uses the released image (`ghcr.io/basmatiactivist/cipherfilm:2`) instead of building from source, and
  replaces `deploy/quickstart/compose.yaml`: download it with `curl` and start it. Building from source:
  docs/SELF-HOSTING.md.
- Deployment simplified: Cipherfilm only needs HTTPS in front. `compose.yaml` is the one production file; the app
  listens on `127.0.0.1:8080` for any reverse proxy (Caddy, nginx, Traefik, a Cloudflare Tunnel, Tailscale Serve, …),
  and `PUBLIC_HOSTS` is required (it replaces the quickstart's `DOMAIN`).
- Backups: back up the data folder with your own tool after `/app backup`; `scripts/backup.sh` and
  `scripts/restore.sh` stay. Any tool can report its result to Admin › Server with `/app backup-report`.

### Removed
- The bundled overlays `compose.tailscale.yaml`, `compose.proxy.yaml`, `compose.caddy.yaml`, `compose.domain.yaml` and
  `compose.kopia.yaml`, their `deploy/` folders, `scripts/kopia-snapshot.sh`, `docs/BACKUP-KOPIA.md` and
  `docs/OWN-DOMAIN.md`.

**Existing installs:** the server works as before and your compose files keep working, but `git pull` deletes the
removed ones, and the new `compose.yaml` doesn't combine with them. Either put your own proxy in front of
`127.0.0.1:8080`, or keep running from a copy of the 2.1.7 files (`mkdir ../cf-2.1.7 && git archive v2.1.7 | tar -x -C ../cf-2.1.7`,
with your `.env`; the volumes keep their names) and set `CIPHERFILM_IMAGE` to the new release. Quickstart installs:
keep your file (it has Caddy), or switch to the new `compose.yaml` behind your own proxy.

## [2.1.7] - 2026-11-07

### Fixed
- Search on apps up to 2.1.3 (still in Google Play's closed test): they stopped with "the server answered 302",
  because the server sent them on to Hugging Face and they follow no redirect. The server now passes the pinned files
  through to them, resumable; newer apps keep downloading from Hugging Face directly.
- Mac: "Indexing 43 of 29". A library refresh while photos were being indexed queued them again, so they were indexed
  and counted twice.
- Public demo: an app that tries to index gets the answer it gets when another device indexes, so every version only
  reads the prebuilt index instead of failing or retrying.

## [2.1.6] - 2026-11-06

### Added
- `DEMO_LOGIN`: a demo server's sign-in page shows the public demo login, with an "Open the demo" button that signs
  in. Only for an account in `DEMO_ACCOUNTS`; the server refuses to start otherwise.

## [2.1.5] - 2026-11-06

A public demo login, and releases that survive a missing Mac runner.

### Added
- `DEMO_ACCOUNTS`: read-only public demo logins. Such an account can sign in, look, download and search. It stores
  nothing at all (visitors share it, so one would read what another stored): the search index is built before the
  account is listed, and the apps only read it. Each visitor sees only its own device; uploads, edits, albums, account changes, recovery and admin actions get a
  403 ("This is the public demo: changes are turned off."). Every write route is closed to it unless listed, and a
  test walks every route. Web, Android and Mac say "Public demo · read-only · resets every hour" and hide upload and
  account deletion; Android doesn't turn backup on for it and says why.
- `deploy/demo`: how to run a demo server (visitors signed out every hour, the whole server reset daily from a seed), and a script that makes the demo account from an
  invite link.

### Changed
- Search engines don't list a Cipherfilm server: every answer carries `X-Robots-Tag: noindex, nofollow, noarchive`,
  the web app has a robots meta tag, and `/robots.txt` keeps crawlers out of the API.
- Releases: "Re-run failed jobs" on a release run attaches what came later (the Mac app, when GitHub had no macOS
  runner) to the existing release instead of failing; Google Play isn't uploaded twice.

## [2.1.4] - 2026-11-06

Search models now come straight from Hugging Face, so the server image drops about 850 MB of models (compressed:
about 784 MB down to 11 MB).

### Changed
- Android, Mac and web download the search models from Hugging Face at URLs pinned to a commit, not through your
  server (slow and often stuck over a tailnet). Every file is still checked against its size and SHA-256. Hugging
  Face sees the device's IP address, nothing of your photos; the apps say so before the download.
- Android: the model download resumes after drops, retries with backoff and drops a stalled connection.
- One model list (`server/models.json`) for the server and every app.
- The server image no longer contains the models (no `MODELS_DIR`). Apps that still ask the server (2.1.x) are
  redirected to the same pinned Hugging Face URL, with the same sign-in and explicit-search checks.
- Web: the Content-Security-Policy allows `huggingface.co` and its CDN (`*.hf.co`) for the model.
- Android: "Immediately" locks every time you leave the app; Android screens the app opens itself (photo picker,
  permission prompts, share sheet) lock only after 10 minutes. After an automatic lock the fingerprint prompt shows
  at once. Account › Lock automatically is now "Lock when you leave the app".
- Android: "Run in the background" updates when you return to the app; on Xiaomi phones it says where to set the
  battery saver to "No restrictions".
- Web: sign-out is instant; the server is told in the background.
- Shorter, plainer texts on Android, Mac and web, in server error messages and command help, and in the docs.
  Deleting no longer says "for good".
- Google Play: the German listing uses the English name, "Cipherfilm: Encrypted Photos".
- README shortened; deployment moved to docs/SELF-HOSTING.md, tools to docs/TOOLS.md. SECURITY.md links to private
  vulnerability reporting.

### Fixed
- Android: locking no longer lets Android stop a running search model download.
- Android: "Search your photos?" is asked once, and only on the library screen.
- Android: no more "Cannot read property … of null" banners when an answer is cut off or the connection drops.
- Web: lock and sign-out cancel requests still in flight, so no late answer is used after the keys are gone, and a
  late 401 no longer shows "Your session has ended".

## [2.1.3] - 2026-11-06

Automatic lock on Android, and the Google Play build is the Play build again.

### Added
- Android: Account › Lock automatically: immediately, after 1, 5 (default) or 15 minutes in the background. The key
  now leaves memory when the time is up, not only when the app is opened again; the lock screen then waits for a tap
  before asking for the fingerprint.
- Android: Account › Lock when the screen turns off.

### Fixed
- Google Play: the bundles of 2.1.1 and 2.1.2 were built as the GitHub app and offered the explicit search model.
  The release now builds the Play bundle as the Play build and checks it.
- The test-account script for the local test server (mobile/dev) runs again.

## [2.1.2] - 2026-11-06

The same app as 2.1.1, now uploaded to Google Play's internal testing track by the release itself.

### Fixed
- Releases: the Play bundle is signed with the key Google Play takes for uploads (the app signing key until the
  separate upload key is registered), so the automatic upload is accepted.

## [2.1.1] - 2026-11-06

Android fixes, and releases go to Google Play's internal testing track by themselves.

### Fixed
- Android: a video fills the viewer like the photo under it, instead of looking cut off and small.
- Android: an empty file (0 bytes) is skipped by the backup and named under Backup ("The file is empty") instead of
  being uploaded as an empty photo; sharing an empty file is refused with the same words.
- Android: a backup with nothing new no longer asks the server (every 15 minutes), and the Backup screen no longer
  says "Everything is backed up" and "Can't connect" at once while the server is down.
- Android: the switch rows under Account line up with the rows around them; the battery hint names OPPO and OnePlus.

### Changed
- Releases upload the Play bundle to Google Play's internal testing track; production is a hand-started workflow
  (Google Play promote). Setup in docs/RELEASING.md, "Google Play from CI".

## [2.1.0] - 2026-11-06

A security release: a fourth full source audit (whole repository, with servers exposed to the public internet as the
threat model) and every finding fixed, plus what Google Play needs. **Operators:** behind your own reverse proxy
(`compose.proxy.yaml`, `compose.caddy.yaml`) `PUBLIC_HOSTS` is now required, and `X-Forwarded-For` is only trusted
from `TRUSTED_PROXIES` (default: loopback and private addresses). The Caddy of the own-domain setup runs as a normal
user now; it fixes its volume's owner on start.

### Security
- Search models are only downloaded by signed-in people.
- Storage limits also count the search index and the people list; tiny files are charged the disk blocks they take;
  list pages are capped in size and per account.
- Sign-in: a bounded queue for password checks, recovery limited per account for known browsers, `X-Forwarded-For`
  only from a trusted proxy, setup closed once an account exists, signing in again ends the previous session.
- The admin activity log can no longer be flushed by users' own sign-outs; a restore keeps device sign-outs made after
  the snapshot.
- Android: a running backup stops when the account or server changes, background jobs never move the app's server,
  shared files are confirmed before upload, deletion only for the phone's own photos, size checks in native code.
- Mac: hardened runtime, upload queue bound to its account, validated ids, names, sizes and segment counts, bounded
  downloads and image decoding, locks when the Mac sleeps or the screen locks.
- Web: upload queue bound to its account, origin checks for workers and the service worker, stricter metadata checks.
- Tools: the decrypt tool keeps every file inside `--out` and checks ids; the uploader refuses odd server answers.
- Releases: no build caches, only tags on `master`, signing keys in a protected environment, provenance attestations
  for every file, Caddy and base images pinned.

### Added
- The installed version of the app and of the server is shown (Account in the web app and on Android, Settings on the
  Mac).
- Android: search is ready seconds after unlocking, from an encrypted copy of the index on the phone (bound to the
  account, deleted at sign-out).
- Install and update the Android app with [Obtainium](https://obtainium.imranr.dev/) (docs/INSTALL.md).
- **Delete your own account:** Account › Delete account in the web app, the Android app and the Mac app (Settings ›
  General). After the password it deletes the account with all its photos, videos, albums, people and search data
  from the server, signs out every device, and each device deletes what it keeps. The only active administrator
  must make someone else an administrator first. Server: `DELETE /api/me` with the current sign-in proof and the
  CSRF token, recorded in the admin log.
- Android: before Android asks for access to photos (Backup, Free up space), the app says what it reads and where it
  goes (only to your own server, encrypted), with Continue / Not now.
- Releases also attach `cipherfilm-play-X.Y.Z.aab`, the bundle for Google Play (signed with the upload key; the app
  is signed by the same key as the APK), and every Android build is checked for 16 KB memory pages.
  `make play-aab VERSION=X.Y.Z` builds the bundle locally.

### Fixed
- Android: "Also the ones already on the phone" applies to every chosen folder, so older photos are backed up; the
  Backup screen counts older photos that aren't in Cipherfilm instead of saying everything is backed up. A file the
  backup keeps failing on no longer blocks the ones after it.
- Android: one upload notification that updates (file, n of m, progress) and one summary at the end.
- Android: sign-in works again with the app built since 2.0.1.

### Changed
- Android 7 to 12: the app can read the photo library again (`READ_EXTERNAL_STORAGE`, only up to Android 12), so
  automatic backup works there too; before, it needed Android 13. Free up space still needs Android 11.
- Android 14 and later: "Allow limited access" works throughout; Backup backs up the photos you chose and offers to
  change the choice, Free up space finds the chosen ones.
- Android: search indexing no longer runs in the upload service (a foreground service for transfers only). Photos
  the backup uploads with the service running are indexed by the next background run instead.
- The Android app from Google Play doesn't ask Android directly to ignore battery optimisation (it opens the list in
  Android's settings) and doesn't offer explicit search. The APK from GitHub keeps both.

## [2.0.1] - 2026-11-05

### Changed
- New logo and app icon, "Photo lock": one teal padlock whose body is the photo. It replaces the photo-plus-padlock
  mark in the web app (logo, favicon, home-screen icon), the Android app icon (including the themed icon) and the Mac
  app, Dock and menu-bar icons.

### Added
- `docs/INSTALL.md`: where to download each part and how to install it, independent of the version.
- `deploy/quickstart/compose.yaml`: the released image behind Caddy with automatic HTTPS, from one file.

## [2.0.0] - 2026-11-05

The project is now called **Cipherfilm**. The encryption format is unchanged: every photo, album, search index and
backup made before stays readable, and `cipherfilm-decrypt` opens old backups. Because the app ids, the image and the
setting names changed with the name, every device signs in once more.

### What you have to do
- **Android:** the app has a new id (`app.cipherfilm`), so it installs as a new app next to the old one. Install
  `cipherfilm-android-2.0.0.apk`, sign in, turn backup and fingerprint unlock on again, then uninstall the old app.
  Backup matches files by name and size, so nothing is uploaded twice. Photos you save from the app now go to
  `Pictures/Cipherfilm`.
- **Mac:** Cipherfilm is a new app (`app.cipherfilm.mac`) with its own settings. Install `cipherfilm-mac-2.0.0.zip`,
  sign in, choose the export folder and the watched folders again and re-enable Touch ID; then delete the old app.
  Export folders now carry a `.cipherfilm-export` marker, so point the export at a new empty folder (or delete the old
  marker file first).
- **Server:** the image moved to `ghcr.io/basmatiactivist/cipherfilm`. The compose project and volume names changed
  (`cipherfilm-prod`, `cipherfilm_data`, `cipherfilm_caddy_data`, …): set the `*_VOLUME` variables in `.env` to your
  old volume names, or copy the data into the new volumes, before you start the new stack.
- **Environment variables:** they now start with `CIPHERFILM_` (`CIPHERFILM_IMAGE`, `CIPHERFILM_PASSWORD`,
  `CIPHERFILM_RECOVERY`, `CIPHERFILM_UPLOAD_STATE`). The old names are no longer read; rename them in `.env` and scripts.
- **Web:** sign in once more; the browser's old caches are not used any more.

### Security
- GitHub Actions hardened: every action pinned to a commit hash, no token left in checkouts, releases built without
  caches and handed only the signing secrets, Dependabot updates only after a cooldown and merged through GitHub's
  own auto-merge once the required checks pass, release files checked for build paths, CodeQL and OpenSSF Scorecard
  for the public repository. Checked with actionlint and zizmor (no medium or high findings).
- The Mac apps of 1.8.0 to 1.11.1 and the Android apps of 1.9.0 to 1.11.1 were built on a personal machine and
  contained its file paths; they were removed from those releases. `scripts/check-artifacts.sh` now checks every
  release file for such paths before upload, and the Mac build maps them away (docs/RELEASING.md).

### Changed
- Renamed to Cipherfilm everywhere: apps, server, image, tools (`cipherfilm-decrypt`, `cipherfilm-upload`), release
  files and documentation. Request headers are now `X-CF-Device` and `X-CF-Session`; all clients and the server ship
  together.
- Web: the first load fetches about 30 % less code (189 instead of 268 KB compressed). The main thread uses libsodium's
  standard build; the sumo build with Argon2 is only in the sign-in worker. The lightbox, people, account, admin and
  recovery screens, the EXIF reader, the ZIP writer and the recovery word list load when first needed.
- Web: previews are kept encrypted in the browser like thumbnails (up to 300 MB, least recently used go first; lock and
  sign-out delete them), so paging back in the viewer downloads nothing again. Search waits 150 ms after typing stops.

## [1.11.1] - 2026-11-05

### Changed
- Admin › Users: explicit search is a button like the other actions ("Allow explicit search" / "Turn off explicit
  search") instead of a checkbox, with an "explicit search" badge on the account; the actions sit in one row under
  the account's details.
- Admin › Activity reads as sentences, grouped by day ("Today", "Yesterday", the date), with the time and an icon:
  "You made anna@… an administrator", "The server console signed out every device of …".

## [1.11.0] - 2026-11-05

### Added
- Server commands, like Immich's: `docker compose exec app /app help` lists them. `status`, `list-users`,
  `make-admin`, `revoke-admin`, `disable-user`, `enable-user`, `delete-user --yes`, `set-quota`, `allow-explicit`,
  `deny-explicit`, `list-sessions`, `sign-out [--wipe]`, `invite` and `reset-password` (which explains why a password
  can't be reset on the server, and what works instead). Changes go to the audit log as "server console";
  docs/SERVER-COMMANDS.md.

## [1.10.0] - 2026-11-05

### Changed
- One design system for all three apps: colors (light and dark), type roles, spacing, radii, shadows and motion live in
  `design/tokens/tokens.json` and are generated into the web, Android and Mac apps (`make tokens`; DESIGN.md, "Tokens").
  The web looks exactly as before. Android and the Mac now use the web's dark palette, the same corner radii and one
  type scale; the Mac's tiles show the favorite heart in the same dark disc as the other apps.

### Fixed
- Mac: the primary button in dark mode had white text on light teal (2.5:1); it is dark ink now (7.8:1).
- Mac: text fields show a teal border while they have the keyboard focus.
- Android: the tick in a checked box was white on light teal in dark mode; it now takes the readable color.
- Android: the "waiting" dot in Backup was Material's stock pink; it is a neutral now.
- Web: the dismiss button of a message and an upload's cancel button are 44 px on touch screens.

## [1.9.1] - 2026-11-05

### Fixed
- Mac: Search & People showed "Can't connect to the server" while the server was fine. Small requests (index pages,
  the people document) allowed only a 20-second pause, which a model download over a relayed tailnet could exceed,
  and the model download gave up after eight tries without data. Requests now allow a one-minute pause, the download
  retries with backoff until it is done and says why it waits, and each failure says what happened (timed out,
  dropped, offline, refused, or the server's answer, such as 404 or 502) and which step of search it stopped.

## [1.9.0] - 2026-11-05

### Added
- **Devices** (web, Account › Devices): every device signed in to the account, with its name, when it was last
  active and which one indexes for search. "Sign out…" ends one device's session, "Sign out all other devices" all
  others. A device signed out this way is told so at its next request (`X-CF-Session: revoked`) and deletes what it
  keeps of the library (web: keys, caches, the kept key; Android: as at sign-out). The apps send a device name
  (`X-CF-Device`, e.g. "Pixel 8 (Android app)"); browsers are named from their User-Agent ("Firefox on macOS").
- **One device indexes.** Per account one device computes the search index; the others only read it and download
  only the small text model (about 66 MB, or 256 MB for explicit search, instead of 250 or 650 MB). The first device
  that indexes becomes that device; "Index here" in the app's search settings moves it. The settings say which device
  it is. Two devices indexing at once did the work twice and, with two models, overwrote each other's entries.
- Android: downloading the search model and indexing go on when the app leaves the screen, in the foreground service
  with a notification ("Downloading the search model · 300 MB of 647 MB", "Indexing for search · 140 of 210").
  Before, both stopped until the app was opened again.
- Web: a reload no longer asks for the password. The tab keeps the key, encrypted with a non-extractable browser key,
  in its sessionStorage; closing the tab, Lock, sign-out or being signed out from another device forgets it.

### Changed
- Sessions last while they are used: 30 days after the last request, at most a year after signing in (before: 14
  days after signing in, and one day without use). Every device had to sign in again every two weeks.
- The server keeps search index entries per model (standard and explicit), so one model's entries never overwrite the
  other's; switching deletes the other model's entries on the server. Entries from before stay readable.
- Faster: the server writes a session's "last seen" at most once a minute (before: with every request, every
  thumbnail included), sorts the library list from an index and sends 2000 items per page instead of 500. The web
  decrypts only new or changed items when the list reloads during an upload (before: all of them every five seconds),
  and the grid's tiles render again only when they change. Android decrypts the library once at start (before: twice),
  renders grid rows only when they change, and starts backup bookkeeping and search after the grid is shown.
- Android and web: switching between standard and explicit search deletes the other model at once (Android: its
  two files, a half download included; web: its text model in the browser's cache); turning search off (Android) or
  signing out (web) deletes all of them. The tokenizer and the face models are shared and stay while search is on.
- Android: where an admin allows explicit search, turning on search always asks "Standard" or "Explicit" first, with
  the real download size for this phone, and only then downloads the chosen model. Before, it downloaded MobileCLIP and
  offered the choice only afterwards.

### Added
- Mac: for people an admin allowed explicit search, turning on search asks which model first, "Standard search
  (MobileCLIP, 250 MB)" or "Explicit search (LAION, 600 MB)", in Settings and in the question after the first unlock,
  and downloads only that one. The switch in Settings › Search & People still changes it later.

### Fixed
- The explicit model (600 MB) never finished downloading over a slow connection: the server cut every model download
  off after 30 minutes, and the apps started again ("server not reachable"). Now a download is cut off only when it
  stalls for two minutes. Android also resumes as long as bytes keep coming and waits out a restarting server.
- Android: choosing "Standard" in the model question kept explicit search if it had been chosen before, and the
  question didn't come up when the admin had allowed explicit search after the app signed in.
- Android: the index vanished and was rebuilt after switching between standard and explicit search, or when another
  device used the other model (see "One device indexes" and entries per model above).
- Mac: the search models never finished downloading from a slow server (a tailnet relayed through DERP brings about
  280 KB/s, so 250 MB take 15 minutes): the download had a 10-minute limit and then showed "Can't connect to the
  server". It now has no overall limit (two minutes without a byte count as a drop), resumes a dropped download where
  it stopped (HTTP Range, also after quitting), tries again with backoff as long as bytes keep coming, and shows the
  progress, speed and time left ("40 MB of 250 MB · 280 KB/s, about 13 min left") or why it is waiting.
- Mac: switching between standard and explicit search deletes the other model's files in both directions (switching
  to explicit search kept MobileCLIP's 210 MB); the tokenizer and the face models are shared and stay.
- Mac: a second copy of the app (one started from Downloads while another runs from Applications) now shows the
  running one's window and quits, instead of both uploading, exporting and indexing.
- Mac: the app built by GitHub Actions (1.7.2, 1.7.3) quit at launch: it was signed ad hoc with the hardened runtime,
  and macOS then refuses the embedded ONNX Runtime ("different Team IDs"). Ad-hoc builds no longer use the hardened
  runtime, and CI now starts the app once to check. The 1.8.0 Mac app (built locally) was not affected.

## [1.8.0] - 2026-11-04

### Added
- Explicit search, off for everyone until an admin allows it per person (Admin › Users, "Explicit search allowed";
  admins included). The person then turns it on in Search settings on any device; it applies to the whole account.
  Search then uses LAION's uncensored OpenCLIP ViT-B/32 (`laion2b_s34b_b79k`, the model Immich ships, MIT, about
  600 MB) instead of MobileCLIP S2, and every device indexes the library again; turning it off goes back. The
  server serves its files only to people allowed it. Immich's ONNX export was checked against LAION's original
  weights (identical vectors). Where the models come from and what was checked: docs/MODELS.md.
- Android: explicit search as above, and search ranked like Immich's: every indexed photo, best match first, no
  cut-off; people, dates, videos and favorites in the query narrow the ranking.
- Server: index writes carry the entry's model tag; where explicit search is allowed, writes without it (from apps
  before this version) are refused with "update the app", so two app versions can't overwrite each other's entries.
- Release: goes out without the Mac app when GitHub has no macOS runner; it is then built locally and attached.
- Mac: explicit search for people an admin allows it: a switch in Settings › Search & People (shown only to them)
  turns it on for the whole account, saved in the encrypted people document. The Mac then downloads LAION's
  ViT-B/32 (about 600 MB, with the session) and looks at every photo again; turning it off goes back to MobileCLIP,
  looks again and deletes the 600 MB. A change made on another device or by an admin is picked up within about a
  minute. Its vectors match the Python reference (ONNX Runtime 1.31.1, Pillow's bicubic resize): text cosine 1.0,
  images 0.990 to 0.9999.
- Mac: search by what is in a photo ranked like Immich, for both models: every indexed photo best match first, no
  cut-off, 200 at a time as you scroll; people, dates, videos and favorites in the query narrow the ranking.
- Web: search by what is in a photo ("dog", "beach", "birthday cake"), as in the Android and Mac apps. The browser
  never looks at photos: it uses the image vectors the apps stored in the encrypted index, opened with the account's
  key, and turns the words into a vector with the same text model (ONNX Runtime Web 1.31.1 in a worker, downloaded
  once from your own server, checked against its SHA-256 and kept in the browser's cache). Ranked like Immich:
  matches by name first, then every indexed photo best match first, 200 at a time as you scroll. Dates, videos,
  favorites and people's names narrow the list: "Anna beach 2023" is Anna's photos from 2023, beach first. Search by
  name now also finds people. Without an index the empty result and Account › Search say to turn on search in the
  Android or Mac app.
- Web: Account › Search, with an "Explicit search" switch for people an admin allows it. It applies to the whole
  account: the Android and Mac apps index the library again with LAION's ViT-B/32, and the browser searches with its
  text model (254 MB, fp32; removed from the browser at sign-out). An int8 copy was tested and rejected: its vectors
  differ too much from the full model's (cosine 0.89 on average, 0.55 at worst).

## [1.7.4] - 2026-11-04

### Added
- Mac: the arrow keys move through the photo grid (⇧ adds to the selection), Space or Return opens the photo.
  VoiceOver reads every tile as a photo or video with its date, and the viewer's icon buttons, arrows and filmstrip by
  name.
- Web: Favorites. A heart in the viewer (key F), in the right-click menu and in the selection bar marks photos; the
  new Favorites page (G then F) lists them, a small heart marks them in the grid, and search finds "favorites".
  Favorites set on the phone or Mac show up in the browser too, and the other way round.
- Web: dark mode that follows the system: the same ink and paper with the light off, every text at WCAG AA contrast
  or better.
- Web: Lock in the account menu drops the keys from memory and asks for the password again, without signing out.
- Web: Select all and Select none in the selection bar on every page with photos, the timeline and the trash
  included (on phones Select all stays in the head of albums, people and favorites, so the bar keeps one row).
- Android: zoom in the viewer: double-tap a photo for a closer look (again for all of it), pinch up to 5×, move it
  with one finger.

### Fixed
- Android: changing the font size in Android's settings while Cipherfilm was open made it close at the next tap.
- Android: after sharing photos to Cipherfilm, Back went through the screens open before instead of leaving the
  app; a share Cipherfilm can't read now says so in plain words instead of a technical error.
- Android: Favorites showed Unfavorite twice in the selection bar.
- Android: Delete album without a connection did nothing; it now says why.
- Android: Next on the keyboard after the e-mail goes to the password; Lock now no longer asks for the fingerprint
  at once (the phone may be in someone else's hand); "Not now" to fingerprint unlock is remembered instead of asked
  at every unlock; Sign out on the unlock screen asks first, like in Account.
- Android: the buttons of the Sign out and Turn off search dialogs ran out of the dialog with large text; they are
  stacked now.
- Android: TalkBack read setting switches without a name and photos by file name; switch rows now toggle as a whole
  and read their title and state, photos read "Photo" or "Video" and when they were taken.
- Mac: buttons that showed nothing under the pointer or while pressed now do: the viewer's icons and arrows, album
  covers, people, the faces of a person, the filmstrip, the album picker, the upload status and the primary buttons.
- Mac: text links (Sign out, Retry, Rename, Use another server) took the text colour and read as plain text; they are
  teal now and underline under the pointer.
- Mac: an error at the top of the library could only be dismissed by clicking it, with nothing saying so; it has a
  close button now.
- Mac: the menu-bar panel showed "Locked" and "Signed out" in the same teal as "Unlocked".
- Web: Select all on more than 500 photos and then Move to trash, Restore, Add to album or a favorite failed with
  "That didn't work". Big selections now go to the server in batches of 500.
- Web: uploads stopped because the server was gone (a restart, an update) said they would continue by themselves
  but only did on a network change; they now try again every 15 seconds.
- Web: notes like "Moved to the trash · Undo", "Added to album" and errors showed at the top of the page and were
  missed when it was scrolled; they now appear under the top bar wherever you are, notes go away after a few
  seconds, errors can be dismissed.
- Web: after closing the viewer, keyboard focus went nowhere; it now lands on the photo last shown. Confirmations
  (Empty trash, Delete forever, Delete album, delete a user) take the focus on their safe button; naming a person
  and renaming an album return it to the button.
- Web: fields that appear later (Rename album, the recovery-key password) didn't get the focus, so typing a name
  could trigger shortcuts such as S for select instead.
- Web: the year bar on the right covered the Select button and error notes; the last short row of a day was taller
  than the rows above it.
- Web: the tab title kept "Timeline" after signing out; the phone search box shows "Search" instead of a cut-off hint.
- Web: the selection bar stayed open on a page with nothing left to select (after unfavoriting the last favorite).
- Web: on phones the selection count shows as a number, so the bar with the new Favorite button still fits one row.
- Web admin: failed user actions (delete, disable, make admin, revoke invite) now say why instead of doing nothing;
  Copy link confirms with "Copied"; a user without a limit reads "4 MB used, no limit" instead of "4 MB of no limit".

## [1.7.3] - 2026-11-04

### Fixed
- Android: a backup that started in the app and went on after leaving it could hang until the app was opened again,
  at the first wait for a retry (React Native stops JS timers off screen); the next runs then didn't start either. A
  headless JS task now keeps the timers going while an upload runs, also in background runs.
- Android: a short network drop (changing networks, the VPN reconnecting) stopped the whole backup with "Can't reach
  the server" although the server was fine. Parts are now retried for about a minute and a half, a file twice more
  after 30 and 90 seconds, and reaching the server three times over half a minute; if it still fails, the backup
  tries again after three minutes instead of the next periodic run. The message shows when it happened.
- Mac: Settings at the bottom of the sidebar shows the same hover, pressed and keyboard-focus look as the other
  sidebar rows.

## [1.7.2] - 2026-11-04

### Added
- Release: the Mac app is attached to every release (`cipherfilm-mac-<version>.zip`, Apple silicon, macOS 15 or
  newer), built by the release workflow with the tag's version. It is not signed by Apple yet: the first start needs
  System Settings › Privacy & Security › Open Anyway.

## [1.7.1] - 2026-11-04

### Changed
- Web and Android: thumbnails in batches too. The tiles that ask within 15 ms go out in one request, newest first,
  tiles that scrolled away are skipped, and the same thumbnail is asked for once; the newest 400 are fetched ahead
  after the library loads. Against a server without the batch route they load one by one as before.

## [1.7.0] - 2026-11-04

### Changed
- Server: `POST /api/items/thumbs` returns up to 100 encrypted thumbnails in one response, so a grid needs one round
  trip instead of one per photo (the Mac app uses it; the old single route stays).
- Mac: thumbnails in batches, decoded off the main thread and fetched ahead; search indexing six photos at a time and
  on battery too, with fewer screen refreshes while it runs; uploads four at a time off the main thread; a Photo menu
  with shortcuts for the quick actions; Settings at the bottom of the sidebar; an upload icon that looks like upload.

### Added
- Web: who is in a photo. The details list every face the Android or Mac app found, with a face picture cropped in
  the browser and the person's name (a link to their photos) or "Add name"; a name someone already has joins them.
  A People page lists named people and groups not named yet; a person's page has Rename and Select all. Faces are
  grouped in a Web Worker with the apps' algorithm, so every device shows the same people; the web computes no vectors
  and, without index entries, says to turn on search in the Android or Mac app.
- Web: Select all on an album's page (and a person's), for the usual selection actions.
- Cipherfilm for macOS (`mac/`, docs/MAC.md): a native SwiftUI app for Apple silicon with the Android app's scope:
  sign in and unlock, timeline by day, viewer with originals, video playback decrypted in memory while it streams,
  favorites, albums, trash with restore, upload by drag and drop and file picker, search of what is in photos and of
  people (naming, merging, hiding, "not this person"), "Photos like this one".
- Mac: export to a folder, kept up to date on its own (or "Export Now"), by year and month or by album, everything,
  favorites or chosen albums. No duplicates: each photo is written once, the same photo uploaded twice becomes one
  file, files already in the folder are adopted, a layout change moves files. Items deleted in the library go to the
  macOS Trash if their copy is unchanged; files renamed or moved in the folder are left alone.
- Mac: unlock with Touch ID (a Secure Enclave key locks a copy of the master key; a new fingerprint turns it off).
- Mac: the server and account are shown on the sign-in and unlock screens, in the sidebar and in the menu bar.
- Mac: year scrubber and "Go to date"; an uploads panel with retry, pause and a queue that survives restarts; drag
  photos out into other apps and Share…; notifications when background work finishes; a person's faces can be picked
  and moved to another person.
- Mac: watched folders upload new photos and videos seconds after they appear, with item keys sealed to the account
  key (also while the library is locked); files the library has (name and size) are skipped.
- Mac: stays in the menu bar with the window closed and can open at login; it indexes the whole library for search
  and faces in the background (by default only on power). Everything can be turned on and off in Settings.
- Mac: the same crypto (checked against the web client's test vectors), the same models and index format as Android
  (vectors checked against the phone's entries: image cosine ≥ 0.998, faces found with the same boxes), libsodium
  1.0.22, ONNX Runtime 1.31.1.
- CI: a macOS job builds the Mac app with xcodebuild and runs its tests; the build is unsigned until signing secrets
  exist.
- Android: shake to lock and close. Two strong shakes lock the library, wipe decrypted images and shared copies, and
  close the app (also out of the recent apps), as some banking apps do in case the phone is grabbed. On by default;
  Account turns it off.
- Android: the photo's details list every face found in it, named or not, and "Add name" names it right there; the
  selection bar has "Select all" (all of a person's photos, an album, search results).
- Android and Mac: a face given to a person ("move to", or named from the photo's details) stays with that person
  even where the automatic grouping put it with someone else.
- Test server (`mobile/dev`): also answers at https://localhost:8443 for the Mac app.

### Fixed
- Server: adding to an album (and other multi-step writes) could fail with a server error while another device
  wrote at the same moment (for example while indexing): transactions now begin immediate and wait for the lock.
- Mac: Save Original saved nothing into folders macOS protects (Desktop, Documents, Downloads) and share did nothing
  visible while it prepared the file; both now write through the app's own staging folder, show what they are doing
  and say when something fails. Photos dragged in from the Photos app or a browser are kept until they are uploaded.
- Mac: a click opens a photo (a long press selects); the viewer has quick actions, a filmstrip and an info column
  that shows every face in the photo and names it there; "Select All" on a person's or an album's page; renaming a
  person reports when it couldn't be saved; ⌘Q keeps the app in the menu bar when it should keep running.
- Mac: a debug build with the test server's certificate set up refused every other server ("answers, but not like a
  Cipherfilm"); the test certificate now applies to the local test server only, and a certificate or name problem
  says so in plain words. Release builds were not affected.

## [1.6.2] - 2026-11-04

### Changed
- Android: the backup starts a few seconds after a photo or video is taken, not only about every 15 minutes. Android
  starts it when its photo library changes, also when the app is closed.
- Android: signing out deletes what the phone keeps for the account: the backup's settings, list and status, the
  search settings and the pinned public key, the session cookie and the cached library (as before). The automatic
  backup and background search stop. The search models stay; they hold nothing of anyone.
- Android: WorkManager 2.12.0.

### Fixed
- Android: turning the backup on (again, or after signing in again) with "also the ones already in these folders"
  could upload photos that were already in the library: the backup now learns what the library has before its first
  run.

## [1.6.1] - 2026-11-04

### Changed
- Android: uploads keep going until they are done (the automatic backup and files shared to Cipherfilm). A
  foreground service holds the app while they run, so leaving the app, locking the screen, swiping the notification
  away or swiping the app out of the recent apps no longer stops them. Before, Android froze the app seconds after it
  left the screen, and a background run stopped after eight minutes. Where Android doesn't allow the service (battery
  optimisation on), a run still stops after a few minutes and the next one goes on.
- Android: the APK is half the size (31 instead of 69 MB): its native libraries are stored compressed. Android
  unpacks them when installing.

### Fixed
- Android: opening the app could start two backup runs at once, which uploaded the same photos twice.
- Android: a backup that Android ended mid-way no longer shows "Backing up…" until the next run.

## [1.6.0] - 2026-11-03

### Added
- Android: search what's in your photos ("beach", "dog", "birthday cake"), on the phone, with Apple's MobileCLIP S2.
  One search box also understands names of people, years and months (English and German), "videos", "favorites",
  "screenshots", file names and cameras. "Photos like this one" from a photo's details.
- Android: people. Faces are found (OpenCV YuNet) and grouped by who they are (SFace) on the phone. Name people,
  join two groups ("same person as…"), take photos out ("not Anna"), hide someone. The people in a photo show in its
  details.
- Search is opt-in: the app asks once, Account › Search and people turns it on or off, with or without faces. The
  models (about 250 MB, open licenses) come from your own server, by default only over Wi-Fi, and are checked against
  SHA-256 values built into the app. Indexing runs while the app is open and, optionally, in the background (by
  default only while charging): new photos are indexed during the automatic backup. The results are encrypted (see
  docs/SEARCH.md), so the server never learns what photos show or who is in them, and other devices reuse them.
- Android: favorites. The heart in the viewer and in the selection bar; Favorites in Albums and in Search. Favorites
  are kept on the server, so all devices see them.
- Android: free up space. Photos and videos on the phone that are already safe in Cipherfilm (same name and size,
  upload finished) go to the phone's trash after Android's confirmation; optionally only older ones or some folders.
- Android: the backup's "only while charging" reads Android's plugged-in state, which some phones report more
  reliably than the battery's charging flag.
- Server: favorites, encrypted search index entries, an encrypted per-account people list, and the search models
  under `/api/models/` (shipped in the image; `MODELS_DIR`).

## [1.5.0] - 2026-11-03

### Added
- Android: automatic backup. New photos and videos in the folders you choose (Camera, Screenshots, WhatsApp
  Images, …) are encrypted on the phone and uploaded in the background, by default only on Wi-Fi, optionally only
  while charging. Each folder remembers its own progress; you choose whether photos already on the phone are
  included. Photos already in your library (same name and size) are skipped. A guided setup asks for photo access,
  photo locations, running in the background (battery optimisation) and notifications, shows what is still missing,
  and explains the extra battery rules of Samsung, Xiaomi and Huawei phones. A notification shows the progress and
  says when you need to sign in again; "Back up now" starts it at once.
- Android: the trash, under Albums. Restore photos or delete them for good.
- A second kind of item key: the background backup seals each new item key to the account's public key, so it can
  add photos without the master key and can never read any. The web app, the Android app, `cipherfilm-decrypt` and
  `cipherfilm-upload` all open both kinds; the server accepts both. See docs/CRYPTO.md.

### Fixed
- Android: release builds keep the classes WorkManager creates by reflection.

## [1.4.4] - 2026-11-03

### Added
- Android: albums. A new Albums tab shows every album with its newest photo; open one to see only its photos and
  swipe through them, rename or delete it, or remove photos from it. Selected photos can be added to an album from
  the library.
- Android: the photo viewer has Share, Add to album, Save and Trash (with Undo) at the bottom.
- Android: videos play in the app, with Android's own player (Media3): play, pause, seek, skip. The player reads
  the encrypted segments and decrypts them in memory as it plays; nothing decrypted is written to storage and no
  local server is involved. Playback pauses when the app goes to the background and stops when it locks.
- Dependabot now also watches the Android app, its native libraries and the Mac uploader.

### Changed
- Android: the library opens at once. The app keeps the server's encrypted copy of the list and the thumbnails on
  the phone (they open only with the key in memory, and are removed when you sign out), so a second start shows the
  grid without downloading it again. Up to 16 downloads run in parallel instead of 5, newest-on-screen first, and
  tiles scrolled past are skipped.
- Web: thumbnails are kept encrypted in the browser's storage between visits (deleted at sign-out), and twice as
  many load in parallel.
- Web: videos buffer three segments ahead instead of one, so playback starts and continues without stalls on a slow
  or distant connection.

### Fixed
- Android: while photos are selected, the selection actions replace the bottom navigation instead of sitting under
  it.

## [1.4.3] - 2026-11-03

### Security
- Android: locking, signing out or a session ending now forgets the decrypted library, its item keys, cached
  previews and shared copies; a list loaded for one account is never shown to another, and nothing that shows the
  library stays on screen once it is locked.
- Android: the automatic lock measures time away with a clock that can't be set back.
- Android: shared files waiting to be uploaded are dropped when you sign out, so they never land in another account.
- Android: a fresh folder for every share, so an app that got one photo can't later read a different one; the
  password salt length is checked before hashing.
- Server: a recovery-key change only goes through while the session and the password that authorised it are still
  current; every request body has a time limit, also when the server answers without reading it.
- Mac uploader: refuses weak password-hashing settings from a server, survives malformed HEIF metadata, and keeps
  control characters from file names out of its messages.

### Added
- `cipherfilm-upload`, a command-line uploader for macOS (`tools/upload`): point it at a folder and it encrypts every
  photo and video in it, subfolders included, and uploads them in the web app's format. Several files and parts go up
  at once, failed requests are retried, and an interrupted run continues where it stopped. Files already in the
  library are skipped. Thumbnails come from macOS itself (sips, QuickLook). Attached to releases for Apple silicon
  and Intel Macs.

## [1.4.2] - 2026-11-03

### Fixed
- Android: sharing to another app and Save to phone handed out empty files. Copies are now written completely, and a
  copy whose size doesn't match is never handed out.
- Android: the actions after selecting no longer scroll sideways; a long press vibrates like other apps.

### Changed
- The Android build in a release starts alongside the tests and reuses caches (NDK, libsodium, npm, Gradle).
- `mobile/dev`: a local throwaway instance for testing the app in the emulator; only unsigned test builds trust it.

## [1.4.1] - 2026-11-03

### Added
- Android: long-press a photo to select, as in Google Photos; then Share (to any app), Add to album, Save to phone
  (Pictures › Cipherfilm) or Trash, with Undo. Shared and saved copies are decrypted into a private folder that
  only the chosen app can read, and removed again afterwards.
- Android: screenshots and screen recordings of the app are blocked, and the app switcher shows the icon instead of
  the library.

### Fixed
- Android: the back arrow on the Account screen showed as a box.
- Android: the keyboard no longer opens by itself during setup, and an unreachable server reads "Can't connect to the
  server" without naming a VPN.
- Web: Account in the menu has a person icon instead of a sun.

## [1.4.0] - 2026-11-03

### Added
- Android app (`cipherfilm-android-<version>.apk` in each release): share photos and videos from any app, or pick
  them with the Upload button; they are encrypted on the phone with the same code as the web app and uploaded.
  Afterwards Android asks once whether to remove them from the phone. Unlock with fingerprint or face (the key stays
  in the phone's secure hardware), library with day headings and a full-screen viewer.
- New icon and logo: a photo print with a padlock.

### Changed
- Web: uploads show in a window in the lower right instead of above the library, with overall progress, speed and
  time left, and every file can be cancelled. Long imports list the files that matter now instead of thousands of rows.

## [1.3.2] - 2026-11-03

### Added
- `PUBLIC_HOSTS`: the name(s) the app is reached by. When set, requests for any other name are refused.

### Changed
- Request bodies must arrive in time (30 seconds for forms, 15 minutes per upload part), so slow clients cannot hold
  the server's handlers open.
- The Kopia overlay runs Kopia as the app's user with no extra capabilities; a short `kopia-perms` step sets the
  owner of Kopia's own volumes first.
- Dependabot pull requests are merged automatically only if the workflow itself set the `automerge` label.

### Fixed
- A sign-in whose password check overlapped a password change or recovery could keep a session.
- Uploads kept running after signing out; they now stop when the account that started them signs out.
- `fotocrypt.sh restore` writes its archive listings to a private temporary folder.

## [1.3.1] - 2026-11-03

### Changed
- The library and the trash are loaded in pages of 500, so a large library no longer needs one huge response.
- Each finished item now counts its encrypted metadata plus 4 KB toward the storage quota, and album entries are
  capped at 200,000 per account.

### Fixed
- A recovery started with the old recovery key can no longer finish after the key was replaced.
- An upload that failed while its item was being deleted could tie up a database connection; with several at once
  the server stopped answering.
- A thumbnail or preview that arrived after its upload was finished was kept on disk without counting toward the
  quota.
- Creating the first account or accepting an invite: a retry after a lost response could show recovery words that were
  never stored. A retry now sends the same keys again, and the app only reports success if the server holds them.
  After a recovery whose response was lost, the app checks the new recovery key itself, not only the new password.
- `scripts/restore.sh` accepts a backup without `blobs/` (taken before the first upload) and refuses to run over a
  restore that stopped half-way, whose data may only be in `.previous/`.
- `scripts/backup.sh` fails when the copy fails (a full disk, say) and leaves no archive that looks complete.
- Two backups at the same time (a cron job and the nightly timer) no longer share their work; the second one stops.
  An empty database never passes as a snapshot.
- `cipherfilm-decrypt` cleans control characters from all text it takes from the backup, errors included.
- The identity check in the git hooks fails closed when it cannot list the commits to check.

## [1.3.0] - 2026-11-03

### Fixed
- An upload retry whose connection broke deleted the part already stored while the server kept it listed as received;
  the app then reported the file as uploaded with a piece missing. A failed or wrong-size part now never replaces or
  removes what is stored, and finishing an upload checks that every part is on disk (a missing one is asked for again).
- "Delete forever" could empty the whole trash: a confirmation left open while the selection dropped to zero sent an
  empty list, which the server read as "everything". The server now needs the items named, the app sends exactly
  the ones shown, and the confirmation disappears when nothing is selected.
- A new recovery key (made in Account, after a recovery, or when an account is created) is now stored only after its
  words are on screen and "I've saved it" is ticked. Before, a lost response could leave a key that works but was
  never shown, with the old one already dead. A retry checks whether the first attempt went through.
- Restoring a backup purged its trash within seconds (the 30 days were counted from today). Restored trash now gets
  a fresh 30 days, and every session ends before the restored app serves anything.
- `scripts/restore.sh` moves the data it replaces to `.previous/` in the volume instead of deleting it, and stops if
  the app keeps running.
- The cleanup jobs no longer delete files when a database query fails, and recheck an item right before deleting it
  (an upload finished or an item restored in the meantime is kept).
- Two password changes at the same moment: the second is refused instead of silently replacing the first.
- After a password change whose response was lost, the page picks up the new settings, so the next try works.
- Quota counted a re-uploaded part twice after a failed retry.
- An unknown command (`/app something`) now fails instead of starting a second server on the same data.

### Changed
- After a recovery or a new recovery key, the app says that older backups still need the previous password or key.

## [1.2.0] - 2026-11-03

### Added
- Admin → Server shows the off-site backup: the last successful nightly run, and a warning on every admin page when
  the last run failed or none has succeeded for 36 hours (`/app backup-report`, called by `scripts/kopia-snapshot.sh`).
- `compose.kopia.yaml`: nightly off-site backups with Kopia (WebDAV/Nextcloud, S3, SFTP, ...), its UI only in the
  tailnet on port 8443; `scripts/kopia-snapshot.sh` and `docs/BACKUP-KOPIA.md` for setup and restore.
- `docs/SERVER-HARDENING.md`: locking down a fresh Debian 13 VPS (keys-only SSH, firewall, fail2ban, automatic
  updates, kernel settings) before Cipherfilm goes on it.

### Fixed
- The database snapshot for backups is written aside, checked with SQLite's integrity check, and only then replaces
  the previous one; a failed run keeps the old snapshot instead of leaving none.

## [1.1.1] - 2026-11-03

### Fixed
- A very long file name in the upload list made the whole page wider than a phone screen. The name is now cut
  off with an ellipsis.
- "Skip to content" moves focus to the content directly instead of through the address bar, which added a
  history entry the app reacted to.

### Changed
- Base images: distroless Debian 13 for the app image, Alpine 3.24 for the backup and restore helpers,
  Tailscale 1.104.4.
- Dependabot also watches the e2e test dependencies and the images in the compose files, and security
  alerts and security updates are on.
- README: current nginx `http2` syntax, Go 1.26 for building the decrypt tool, ready-made decrypt binaries on
  every release.

### Added
- `scripts/check-identity.sh` and git hooks in `.githooks` that refuse commits, tags and pushes under a real
  e-mail address; CI runs the same check on every push.

## [1.1.0] - 2026-11-02

### Added
- Search by capture date (year, month, day), camera, file type and album name, not only by file name. It runs in
  the browser over the decrypted metadata; the server never sees a search.
- Uploads hold up on phones and bad connections: the screen stays on while files upload, closing the tab asks
  first, a file stopped by a lost connection continues by itself when the connection is back, and after a reload
  the library lists unfinished uploads, which continue where they stopped when chosen again.
- `docs/MIGRATION.md`: moving an instance from the Mac setup to a server, or between servers.
- Dependency updates from Dependabot merge themselves after the full CI is green; major versions wait for a person.

### Changed
- The browser suite (Playwright), the plaintext leak check and an automated migration test (backup, restore on a
  new stack, sign in, decrypt offline) now run in CI on every push and before every release.
- `make e2e` uses its own stack (`compose.e2e.yaml`, app behind Caddy with HTTPS) and needs only Docker.
- Playwright 1.64, axe-core 4.14.

### Fixed
- Accessible names now contain the visible label (upload button, tiles without a preview, ZIP button on phones).
- The upload benchmark measured the test tool instead of the app. Real large uploads run at 127 to 197 MB/s
  (WebKit, Firefox); see `docs/UPLOAD-PERFORMANCE.md`.

## [1.0.0] - 2026-11-02

First stable release.

### Added
- End-to-end encrypted photo and video library: files, thumbnails, metadata and album names are encrypted
  in the browser; the server never sees keys or plaintext (see `docs/CRYPTO.md`).
- Invite-only accounts with an admin area: users, per-person storage limits and a default limit, role
  changes, server status, activity log. Recovery key per person.
- Timeline with justified rows and a year scrubber, albums, trash, search by file name, selection with
  range and multi-select, drag and drop, right-click quick actions and keyboard shortcuts.
- Lightbox with info panel and filmstrip; video streaming through a Service Worker; HEIC support.
- Parallel, resumable-by-file uploads with worker-based thumbnails.
- Offline decrypt tool (`cipherfilm-decrypt`) that reads the data folder or a backup directly, without the
  server, for macOS, Linux and Windows.
- Deployment overlays for Tailscale, your own reverse proxy and Caddy with automatic HTTPS.
- Multi-architecture container image (amd64, arm64) on `ghcr.io`, built with provenance and SBOM.

### Security
- Independent security audits of the server, the client crypto and the deployment; findings fixed
  (summary in `SECURITY.md`).
- Rate limiting with known-device handling, CSRF protection, `__Host-` cookies, strict CSP, read-only
  container with all capabilities dropped.
