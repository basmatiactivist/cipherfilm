# Search and people (computed by Android and Mac; used on the web too)

The Mac app (docs/MAC.md) runs the same models with the same preprocessing and writes the same entries; it indexes
the whole library in the background while it is unlocked. Entries from either device are used by the other.

Cipherfilm can find photos by what is in them ("beach", "birthday cake") and group the faces in them into people
you can name. All of it runs on the phone. The server stores the results encrypted, so it never learns what a photo
shows or who is in it, and another device of the same person doesn't have to compute them again.

Search by place ("zurich", "japan") needs none of this: it works from the photos' encrypted coordinates and the place
names bundled with the apps, on the device, whether search or the map is on or not (docs/MAP.md).

Search is off until the person turns it on (the app asks once after unlocking; Account › Search and people changes it
any time). Turning it off removes the models from the phone; "Delete everything" also removes the index and the people
list from the server.

## Models

Open models, downloaded by the phone once (about 650 MB with faces, by default only on Wi-Fi), after the person agreed
in a question that says what, how big, from whom and what Hugging Face learns (docs/MODELS.md "Asked first"), directly
from Hugging Face, where they are published, at URLs pinned to a commit. Each file's URL, SHA-256 and size are in
`server/models.json`, the one list the server and every app use; the app checks size and SHA-256 before it opens a
file. A dropped or stalled download continues with HTTP Range. Hugging Face sees the phone's IP address, nothing about
the photos (docs/MODELS.md). Older apps that still ask `GET /api/models/{name}` get the same file, passed through by
the server.

| File | Model | What for | License | Size |
|---|---|---|---|---|
| `clip-b32-vision.onnx` | LAION's OpenCLIP ViT-B/32 (`laion2b_s34b_b79k`), image encoder, fp32 (Immich's export, [immich-app/ViT-B-32__laion2b-s34b-b79k](https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k)) | what is in a photo | MIT | 351.6 MB |
| `clip-b32-text.onnx` | the same model's text encoder, fp32 | what the search words mean | MIT | 254.2 MB |
| `clip-b32-tokenizer.json` | CLIP BPE tokenizer (from the same export) | words to tokens | MIT | 3.6 MB |
| `yunet-2023mar.onnx` | OpenCV YuNet ([opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet)) | where faces are, with five landmarks | MIT | 0.2 MB |
| `sface-2021dec.onnx` | OpenCV SFace ([opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface)) | a 128-number description of each face | Apache 2.0 | 38.7 MB |

What a device downloads: the indexing device all of it (609 MB, 648 MB with faces); a device that only searches
(another one indexes) the text model and the tokenizer (258 MB); the web app the same 258 MB.

- Image: input `image`, float32 `[1,3,224,224]`: RGB, shortest side to 224 (bicubic or a good downscale), centre crop,
  `/255`, then per channel `(x - mean) / std` with mean `[0.48145466, 0.4578275, 0.40821073]` and std
  `[0.26862954, 0.26130258, 0.27577711]`.
- Text: input `text`, **int32** `[1,77]`, ids padded with 0 (padding doesn't change the output). Search words are
  English.
- Outputs: `embedding` `[1,512]`, already L2-normalised. Stored as fp16.
- Index entry tag `m`: `laionb32+yunet23+sface21/1` (with faces) or `laionb32/1` (without): the family `laionb32`.
- Text search ranks like Immich's smart search: every photo with an entry, best match first, no cut-off, shown page
  by page as you scroll (the first 200, then more). Filters (people, years, months, favorites, videos) narrow the
  ranked list instead of being separate results. Explicit content is left out unless chosen (below).
- LAION-2B, the training data, tagged explicit images instead of removing them, so the model knows those concepts;
  that is what the filter below uses. Immich ships the same model for its smart search. LAION-5B was withdrawn in
  December 2023 after abusive material was found in it and re-released cleaned in 2024; this checkpoint was trained
  before that. Its weights remain openly distributed (docs/MODELS.md).

ONNX Runtime for Android ships a usage-telemetry client that starts with the app and reports to Microsoft; the app's
manifest removes it (`mobile/modules/cf-native/android/src/main/AndroidManifest.xml`) and telemetry is switched off
in code too. Cipherfilm talks only to its own server, and to Hugging Face for the models.

## One model

Until 2.6.x, search used Apple's MobileCLIP S2 for everyone and LAION's ViT-B/32 only for explicit search. MobileCLIP
S2's weights are under Apple's research-only license (`apple-amlr`, docs/MODELS.md), so no build uses it any more: the
LAION model, which explicit search already used, is everyone's model now, in every build (Google Play, GitHub, web,
Mac), with one index per account. Explicit content is filtered instead (below).

- **Files:** LAION's two files are the same as before under neutral names (`clip-b32-*` instead of `nsfw-laion-b32-*`).
  A device that has them under the old names moves them (no new download; checked by SHA-256 as always) and deletes
  MobileCLIP's files. The tokenizer is now the one in Immich's export (the same ids). Asked first, as for any download
  (docs/MODELS.md): files already on the device count as agreed, MobileCLIP's yes doesn't cover the new files.
- **Accounts that used explicit search** already have the LAION index (`laionb32`): it stays, nothing is indexed again.
- **Accounts with only MobileCLIP's index** (`mcs2`): the indexing device (any build, also a phone from Google Play)
  makes the new entries. It reads MobileCLIP's entries once for their faces and puts those into the new entries, so
  only the image model runs per photo and the people document's names stay with their faces (it names them
  `<item>:<n>`). The server drops an item's MobileCLIP entry when the new one is stored; once every photo has the new
  entry, the indexing device deletes what is left (`DELETE /api/index?model=mcs2`). Until a photo has its new entry,
  updated devices don't find it by content (MobileCLIP's vectors don't compare with LAION's); people and places work
  meanwhile.
- **Server:** index writes take only `laionb32` entries. An older app that still sends MobileCLIP's (or untagged ones,
  from before 1.9.0) gets 409 `not_indexer`, so it stops indexing instead of running its model on every photo, and if
  it was the indexing device it no longer is: the next updated device that indexes takes over. `GET /api/index?model=mcs2`
  still returns MobileCLIP's entries (with the untagged ones) until they are gone; `?model=laionb32` returns only
  LAION's. `DELETE /api/index?model=laionb32` is refused (409): older apps asked it when explicit search was turned off,
  and LAION's entries are everyone's index now. MobileCLIP's files are not passed through any more; the LAION files
  are, to everyone, also under their old names.
- **Older apps** still on MobileCLIP find fewer and fewer photos by content as the index moves to the new model, and
  none once it has: they need the update. Older apps with explicit search on keep working (same model, same index).

## Explicit content

Search leaves out photos that look explicit and finds nothing for explicit search words ("No results", no lecture),
unless an admin allowed **explicit search** for the person and they chose it. People, places, albums, the timeline,
a photo's details, similar photos and duplicates are not filtered: it is the person's own library; only search is.

- **Allowed** per person by an admin (Admin › Users, "Allow explicit search"; `users.nsfw`, `PATCH
  /api/admin/users/{id}` with `{"nsfw": true}`, or `allow-explicit` on the server). Off for everyone, admins included,
  until an admin turns it on; `GET /api/me` returns it as `user.nsfw`.
- **Chosen** by the person in Search and people ("Explicit search"), for the account: `"explicit": true` in the
  encrypted people document (`user_blobs` "people", docs/CRYPTO.md), so all their devices follow. Turning it on or off
  changes only what search shows: nothing is downloaded, indexed again or deleted.
- **Never in the Android app from Google Play** (built with `CF_STORE=play`, `mobile/src/store.ts`): it doesn't offer
  the switch and always filters, whatever the account chose. The APK from GitHub, the web app and the Mac app offer it.

How it works: a fixed set of short texts ("concepts") was turned into vectors once with the model's text encoder
(`scripts/explicit-filter.py`, which writes `server/explicit-filter.json`, read by the web and Android apps when they
are built, and the Mac's copy `mac/Sources/CipherfilmCore/ExplicitConcepts.swift`; a Mac test compares the two). 12
describe explicit photos ("a photo of a naked person", …), 40 what else a photo can be ("a photo of a person", "a
photo of people at the beach", "a screenshot", "a landscape photo", …), and 61 single words for search (17 explicit,
44 everyday ones that sound alike: "swimsuit", "bath", "statue", …). No device runs the text model for it.

- **A photo's score** is the cosine of its image vector to the closest explicit photo concept minus that to the closest
  neutral one. At or above `image.threshold` (0.01) it is left out of filtered search. Comparing with neutral concepts,
  not only with explicit ones, is what keeps ordinary photos of people out: they are closer to "a photo of a person"
  than to any explicit concept.
- **Search words** are scored the same way over all concepts (their text vector, which the device computes anyway);
  at or above `query.threshold` (0.03) the search finds nothing.
- The score is worked out on the device when an entry is opened, from the vector that is in it (Android: the native
  index, `SearchIndex.kt`; web: the search worker; Mac: `SearchIndex.swift`), and kept in memory only. Nothing is
  stored for it, in the entry or anywhere else, and nothing is sent: the server learns nothing, entries made before
  the filter existed (the LAION index of explicit search) are filtered without indexing again, and a later release can
  change the concepts or thresholds the same way.

**Checked so far, and what is left:** the repository's pictures (app screenshots, icons, the e2e fixtures, flat colours,
noise) score at most -0.006; skin-coloured blob shapes up to +0.028 (left out, harmless). Of 92 everyday search words,
4 find nothing ("naked eye", "sex education book", "sex pistols", "adult"); of 30 explicit ones, 23 are blocked (those
that get through, such as "nude beach" or German "titten", still don't show photos the image side left out). Run
`python3 scripts/explicit-filter.py <models> --check <images>` for the numbers. Explicit photos can't be part of the
repository: **the thresholds must be checked by the owner on real photos before a release**, and changed in
`scripts/explicit-filter.py` (the one place; the script writes both copies).

## One device indexes (1.9.0)

Computing the index is the expensive part, and two devices doing it at once did the work twice and, with two models,
undid each other. So per account **one device indexes**; every other device only reads the entries
(`GET /api/index?model=<family>`) and downloads only the text model and the tokenizer, to turn search words into a
vector.

- The indexing device is a session (`users.indexer`, the session's public id). `GET /api/me` returns
  `session_id` (this device) and `indexer` (the indexing device's id, `""` when there is none or its session ended).
- The first device that writes an entry becomes the indexer. Any other device's `PUT /api/items/{id}/index` gets
  **409 with `"code": "not_indexer"`**: it stops indexing and only reads from then on.
- `PUT /api/me/indexer` makes this device the indexer (the person chose it: "Index on this device"),
  `DELETE /api/me/indexer` gives it up (search turned off here). When the indexer signs out, is signed out or expires,
  the next device that indexes takes over.
- The apps show it in their search settings: "This device indexes your photos" or "Indexed by <device>, last seen
  …", with "Index on this device instead". The web's Account › Devices marks the indexing device.
- Taking over downloads the image (and face) models again: a device that only reads deleted them, and the yes to
  download them with them (docs/MODELS.md). So "Index on this device instead" asks first; the role moves after the
  yes. A device that becomes the indexer any other way (the indexer signed out or gave it up) waits in "Waiting for
  your OK to download the models" until the person answers.
- **When the indexing device stops.** It may wait for its own OK to download the models after an update, or be gone
  without signing out; then nobody indexes new photos. The Mac says it where it matters: Settings › Search & People
  and an empty search name how many photos and videos aren't indexed yet, next to "Index on This Mac Instead"
  (`Models.waiting`: the photos the indexing device would index, without an up-to-date entry). The role is not handed
  over automatically: the server can't tell an indexer that stopped from one that waits for power, Wi-Fi or the
  person's OK, nor (the items' kinds are encrypted) photos that can't be indexed from ones not indexed yet; handing
  it over by itself would make every device download several hundred MB of models it then may not use. A session
  that expires (unused for its lifetime) or is signed out under Account › Devices frees the role as before.

## Devices

`GET /api/me/sessions` lists the account's signed-in devices: `id` (a random public id, not the cookie), `device`,
`created_at`, `last_seen` (updated at most once a minute), `current`, `indexer`. `DELETE /api/me/sessions/{id}`
signs one out (not this one: that is sign-out), `POST /api/me/sessions/end-others` all others; both are in the audit
log. A signed-out device gets 401 at its next request and forgets the library as at sign-out. The device name is what
the app sends as `X-CF-Device` at sign-in (Android: "<model> (Android app)", Mac: "<computer name> (Mac app)"),
otherwise a guess from the browser's User-Agent ("Firefox on macOS"); it is only a label. Account › Devices on the web,
Android and the Mac shows the list. A new sign-in also leaves a notice for the devices signed in before it
(`GET /api/me/notices`, `POST /api/me/notices/{id}/dismiss`, live topic `notices`; server/notices.go).

## Pipeline (`mobile/modules/cf-native/.../Vision.kt`)

- **Image vector:** the decrypted preview (2048 px) is scaled so its short side is 224 px, centre-cropped to
  224 × 224, RGB normalised with CLIP's mean and std (above), through the image encoder; L2-normalised 512 numbers.
- **Faces:** the image letterboxed into 640 × 640 (BGR, 0..255) through YuNet; candidates with
  `sqrt(cls·obj) ≥ 0.82`, non-maximum suppression at IoU 0.3. Each face is turned upright with a least-squares
  similarity transform from its five landmarks onto ArcFace's 112 × 112 reference points and described by SFace
  (RGB, 0..255); L2-normalised 128 numbers.
- **Text:** CLIP's byte-level BPE (`mobile/src/search/tokenizer.ts`, checked against Hugging Face's tokenizer),
  77 tokens, through the text encoder.
- **Search:** cosine similarity of the text vector against all image vectors, in native memory; results within 0.09
  of the best match and above 0.15. Names of people, years and months (English and German), "videos", "favorites",
  "screenshots", file names and cameras narrow the results first.
- **People:** faces with a detector score ≥ 0.86 and at least 4 % of the image are grouped greedily against each
  group's running mean (cosine ≥ 0.5), then groups whose means are within 0.55 are joined. A group shows as a person
  from three photos on. Names and decisions ("same person as…", "not this person", hidden) are anchors: groups holding
  a person's named faces are joined under them, faces taken out never return to them. A face given to a person
  (an anchor) stays with them even where the grouping put it with someone else, so "move to" and naming a single
  face in a photo's details work (Android and Mac).

## On the web

The web client never looks at a photo: it reads the entries the Android and Mac apps stored. After unlocking it fetches
them (`GET /api/index`, page by page, again at most once a minute), opens them with the account's private key in the
browser and keeps the image vectors and the faces (box, score, vector) in memory. They are grouped in a Web Worker with a port of the
same algorithm (`web/src/people/faces.ts`, tested against the Mac's test case), so every device shows the same people.
The people document is read and saved with the same version check and retry as the apps. Face pictures are cropped
from the decrypted thumbnail or preview in the browser.

- A photo's details list every face in it, with the person's name (a link to their photos) or "Add name". A name
  someone already has joins the face, or its group, to them.
- People: named people, then groups not named yet (from three photos); a person's page shows their photos, with
  Rename and Select all (as on an album's page) for the usual selection actions.
- **Search by what is in a photo:** after the person agreed (the first search, or Account › Search, asks; per
  browser, `web/src/search/consent.ts`), the browser downloads the model's text encoder and the tokenizer (258 MB) once from
  Hugging Face (`web/src/search/content.worker.ts`; ONNX Runtime Web in a worker, checked against the same SHA-256,
  kept in the browser's cache), turns the words into a vector and ranks the stored image vectors, as the apps do,
  with the explicit-content filter (the worker scores each vector as it comes in, `web/src/search/explicit.ts`, the
  same code as on Android). Account › Search shows how many photos can be found and, for people an admin allowed it,
  the "Explicit search" switch for the account. A text model cached by an earlier version under its old name
  (`nsfw-laion-b32-text.onnx`) is moved to the new one; MobileCLIP's files are deleted from the cache.
  It also says when the model was downloaded and turns search off in this browser, deleting the model and the yes.
  Sign-out deletes the cached models and the yes.
- Without index entries the People item is not shown, and a photo's details, an empty search and Account › Search say
  to turn on search in the Android or Mac app.
- Everything (vectors, faces, groups, names, crops) is dropped at sign-out and when the tab is closed or reloaded.

## What is stored, and how

| What | Where | Encryption |
|---|---|---|
| Index entry per item: model tag, image vector (float16), faces (box, score, float16 vector) | server, `item_index` | sealed to the account's public key: `0x02 ‖ crypto_box_seal(item id (16 bytes) ‖ pad₅₁₂(JSON))` |
| People: names, anchor faces, taken-out faces, hidden | server, `user_blobs` "people" | XChaCha20-Poly1305 under `kdf(master, "PEOPLEST")`, AD `blob/people \0 user id`, padded to 1024 bytes |
| Favorites | server, `items.favorite` | plain flag, like album membership |
| The server's index entries (ciphertext) | phone cache | as on the server; removed at sign-out |
| The opened index (vectors and faces), so search works seconds after unlocking | phone cache, `cf-ct/<user id>/index-<family>.bin` | XChaCha20-Poly1305 under `kdf(master, "IDXCOPY1", 1)`, bound to the account and model family; removed at sign-out |
| Decrypted vectors | phone, native memory; web: faces only, browser memory | none; removed at every lock (web: at sign-out, reload or tab close) |

Entries are sealed to the public key (like the background backup's item keys) so the phone can index in the
background without the master key. The item id inside the sealed box ties an entry to its item; the server cannot move
one to another photo. As with sealed item keys, anyone holding the public key (also a malicious server) could insert
made-up entries, which could make a photo show up in a search where it doesn't belong; it can't read any.

## When it runs

- **While the app is open and unlocked:** opens the encrypted copy of the index on the phone first (search works at
  once), then downloads the models if needed (only with the person's yes for those files; otherwise search waits for
  it, phase `consent`), fetches the entries other devices made,
  then indexes every photo and video in the library that has none (from the decrypted preview, two at a time).
- **In the background** (the backup's WorkManager task, about every 15 minutes when Android allows; by default only
  while charging): photos on the phone that are in the library but not indexed yet are indexed from the phone's
  files. A photo the backup just uploaded is indexed from the phone's own file right away when the run is a plain
  WorkManager run; a run that holds the upload service (`TransferService`, a `dataSync` foreground service for
  transfers only, as Google Play requires) only notes it, and the next background run indexes it. Photos that exist
  only on the server need the master key and wait for the app.
- Indexing never runs in a foreground service: only the model download does (a transfer). With the app closed, the
  app's own indexing of server-only photos pauses until it is opened again.
- Android may delay background work. Allowing Cipherfilm to run in the background (battery optimisation) makes it
  reliable on most phones; some makers (Samsung, Xiaomi, Huawei) need "Unrestricted" in the app's battery settings.

## Free up space

Account › Free up space lists photos and videos on the phone whose name and size match a finished item in the library
(not in the trash). Optionally only older ones and only some folders. They go to Android's own trash
(`MediaStore.createTrashRequest`, restorable for 30 days) after the system's confirmation dialog.

## Duplicates and similar photos

Web (account menu) and Android (Account) list photos that are there more than once or look nearly the same, so the
extra ones can go to the trash (restorable for 30 days). Everything is worked out on the device from what it has
already decrypted; nothing new is stored or sent, apart from the usual trash request for what the person chose.

- **Exact duplicates:** the same file. Newer uploads carry the original's SHA-256 in their encrypted metadata
  (`sha256`, docs/CRYPTO.md): equal hashes are the same file whatever the names, and different hashes never are. Older
  items have none; for them the same size in bytes and the same capture time (to the millisecond) count whatever the
  name ("IMG_1.jpg" and "IMG_1 (1).jpg", the same photo uploaded from two devices), as long as the pixel size agrees
  (either way round) where both know it; the same name, size and capture time count as before. An older item joins a
  group only if it matches every member without a hash, so groups are never chained together. Videos and other files
  count too.
- **Similar photos:** photos whose image vectors (the search index above)
  have a cosine of at least 0.92 and that were taken at most 5 minutes apart: bursts and near-identical series. Every
  photo in a group is that close to every other one (complete linkage), so a slow series is never chained into one
  big group. Photos are sorted by capture time and each is compared only with the next 24 within the window, so a
  library of 50,000 needs well under a million comparisons. Only one copy of an exact duplicate takes part. Photos
  without an entry yet are left out; with search off, only exact duplicates.
- **What was checked:** the screen always says it: how many photos and videos were checked for exact copies, and for
  similar photos whether search is off (with the way to turn it on: Account › Search and people on Android; on the
  web, which can't index, the Android or Mac app), how many of the photos are indexed ("X of Y"), or that all were
  compared. With search off or only part indexed it says "No exact copies found", never "No duplicates found".
- **Which to keep:** the highest resolution, then the largest file, then one with a location, then the earliest
  upload. All others in a group are chosen for the trash; the person can change that. Items that couldn't be verified
  and the trash are never included. The public demo shows the groups but can't move anything.

The grouping is one module shared by both apps (`web/src/cleanup/duplicates.ts`, `@cleanup` on Android). The web app
scores the pairs in its search worker; on Android the native index scores them (`indexScores`), so the vectors never
leave native memory. The Mac app doesn't have it yet.

Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.
