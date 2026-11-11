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

Open models, downloaded by the phone once (about 250 MB, by default only on Wi-Fi) directly from Hugging Face, where
they are published, at URLs pinned to a commit. Each file's URL, SHA-256 and size are in `server/models.json`, the one
list the server and every app use; the app checks size and SHA-256 before it opens a file. A dropped or stalled
download continues with HTTP Range. Hugging Face sees the phone's IP address, nothing about the photos (docs/MODELS.md).
Older apps that still ask `GET /api/models/{name}` get the same file, passed through by the server.

| File | Model | What for | License |
|---|---|---|---|
| `mobileclip-s2-vision.onnx` | Apple MobileCLIP S2, image encoder, fp32 ([Xenova/mobileclip_s2](https://huggingface.co/Xenova/mobileclip_s2)) | what is in a photo | Apple Sample Code License |
| `mobileclip-s2-text.onnx` | MobileCLIP S2, text encoder, int8 | what the search words mean | same |
| `mobileclip-s2-tokenizer.json` | CLIP BPE tokenizer | words to tokens | same |
| `yunet-2023mar.onnx` | OpenCV YuNet ([opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet)) | where faces are, with five landmarks | MIT |
| `sface-2021dec.onnx` | OpenCV SFace ([opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface)) | a 128-number description of each face | Apache 2.0 |

MobileCLIP S2 was chosen over OpenAI's CLIP ViT-B/32 for clearly better zero-shot accuracy (ImageNet 74.4 % vs 63.3 %)
at a smaller, faster image encoder. The int8 image encoder was rejected: its vectors differ from the full-precision
model's (cosine ~0.05). The fp16 export matches on x86, but ONNX Runtime runs it with half-precision arithmetic on
ARM phones, where MobileCLIP's activations overflow and the vectors become useless; the fp32 file is used. Search
words are English.

ONNX Runtime for Android ships a usage-telemetry client that starts with the app and reports to Microsoft; the app's
manifest removes it (`mobile/modules/cf-native/android/src/main/AndroidManifest.xml`) and telemetry is switched off
in code too. Cipherfilm talks only to its own server, and to Hugging Face for the models.

## Explicit search (off by default; per person, allowed by an admin)

MobileCLIP S2 was trained on data with sexual content filtered out (DataComp), so it barely understands explicit
terms. For people who want that, an admin can allow **explicit search** per person (Admin › Users, "Explicit search
allowed"; `users.nsfw`, `PATCH /api/admin/users/{id}` with `{"nsfw": true}`). It is off for everyone, admins
included, until an admin turns it on, and `GET /api/me` returns it as `user.nsfw`.

The person then chooses it themselves in Search and people ("Explicit search"). The choice is **per account**, not
per device, because all devices share one index: it is stored as `"explicit": true` in the encrypted people document
(`user_blobs` "people", docs/CRYPTO.md). The model used is:

- `laion-b32` if `me.user.nsfw` **and** the people document has `explicit: true`;
- `mobileclip-s2` otherwise (also when the admin later withdraws the permission).

The Android app from Google Play (built with `CF_STORE=play`, `mobile/src/store.ts`) never offers explicit search
and always uses `mobileclip-s2`, whatever the account chose; the server's permission stays as it is, and the APK from
the GitHub releases, the web app and the Mac app keep the option. On an account that chose explicit search, a Play
phone searches the standard model's entries, which the indexing device keeps complete (below); if the Play phone is
itself the indexing device, it builds only those, and the account's explicit-search devices find LAION's index empty
until one of them indexes ("Index on this device instead").

Every index write (`PUT /api/items/{id}/index`) carries the entry's tag in the clear as `"model"` (the entry itself
stays sealed). Where explicit search is allowed, the server takes writes only with it (409 otherwise): an app from
before explicit search would take the other model's entries for outdated and overwrite them, back and forth; it is
asked to update instead. The server learns only which of the two models an account uses, nothing about the photos.

The server keeps entries **per model family** (`item_index` key `(item_id, model)`, the family being the tag up to
`+` or `/`: `mcs2`, `laionb32`), so the two models' entries never overwrite each other. Entries from before 1.9.0 have
the family `''` and are returned with either; the first write of a family for an item replaces such an entry.

**MobileCLIP's index stays complete.** Every device reads the family it searches with: `laionb32` where the account
chose explicit search and the device offers it, `mcs2` everywhere else (the Play build, an older app, a device of
someone the admin didn't allow, the web app's standard search). So while explicit search is on, the indexing device
(below) keeps **both** families current: for every photo it runs both image models (LAION's and MobileCLIP's) on the
same decoded picture, finds the faces once, and stores two entries, `laionb32+…` and `mcs2+…`, with the same faces
(the people document names faces by their place in an entry, so both list them alike). It downloads MobileCLIP's
image model next to LAION's two (not MobileCLIP's text model: it searches with LAION). The Android background task
and the Mac's watched folders do the same for new photos. With explicit search off it computes `mcs2` only, as
before.

- Turning explicit search **on** deletes nothing: the indexing device adds LAION's entries; MobileCLIP's stay and
  are kept current.
- Turning it **off** deletes LAION's entries (`DELETE /api/index?model=laionb32`, frees their storage); MobileCLIP's
  are already there, so nothing is indexed again.
- An item counts as done only when both of its entries are current. An item missing one of them (MobileCLIP's were
  deleted by apps before this change, which dropped them when explicit search was turned on) gets only that one made
  again: one image model pass, the faces taken from its other entry.
- On the phone, the copies of both families' entries (`cf-ct/<user id>/index-<family>.json` and `.bin`) stay next to
  each other; the cleanup of cached pictures leaves them alone (until 2.6.1 it deleted them after every library
  load, so each start fetched the whole index again).
- So a device notices entries deleted on the server since its last visit, the first page of `GET /api/index` carries
  `count`, the number of the family's entries in all; a device whose cached copy holds more fetches the family again
  from the start and makes again what is missing.

The cost while explicit search is on, on the indexing device only: one more image encoder pass per photo (MobileCLIP
S2, the smaller of the two; no second decode, no second face detection), MobileCLIP's image model (143 MB) on disk
and in memory next to LAION's, and a second entry per photo on the server (a few KB; it counts toward the storage
limit). Reading devices are unchanged.

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

## Devices

`GET /api/me/sessions` lists the account's signed-in devices: `id` (a random public id, not the cookie), `device`,
`created_at`, `last_seen` (updated at most once a minute), `current`, `indexer`. `DELETE /api/me/sessions/{id}`
signs one out (not this one: that is sign-out), `POST /api/me/sessions/end-others` all others; both are in the audit
log. A signed-out device gets 401 at its next request and forgets the library as at sign-out. The device name is what
the app sends as `X-CF-Device` at sign-in (Android: "<model> (Android app)", Mac: "<computer name> (Mac app)"),
otherwise a guess from the browser's User-Agent ("Firefox on macOS"); it is only a label. Account › Devices on the web,
Android and the Mac shows the list. A new sign-in also leaves a notice for the devices signed in before it
(`GET /api/me/notices`, `POST /api/me/notices/{id}/dismiss`, live topic `notices`; server/notices.go).

**The model:** LAION's OpenCLIP ViT-B/32 (`laion2b_s34b_b79k`, MIT), trained on LAION-2B, where explicit images were
tagged, not removed. Immich ships the same model for its smart search. Files (Immich's split ONNX export, commit
`19a057a0fb927cf239541300e74237cd56c7ffe2`), served only to people allowed explicit search (`nsfw-*` names need a
session with `user.nsfw`; the apps send their session cookie):

| File | Size | SHA-256 |
|---|---|---|
| `nsfw-laion-b32-vision.onnx` | 351,613,724 | `b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c` |
| `nsfw-laion-b32-text.onnx` | 254,193,396 | `48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722` |

- Tokenizer: the same CLIP BPE as MobileCLIP (`mobileclip-s2-tokenizer.json`; ids checked identical), context 77.
- Image: input `image`, float32 `[1,3,224,224]`: RGB, shortest side to 224 (bicubic or a good downscale), centre crop,
  `/255`, then per channel `(x - mean) / std` with mean `[0.48145466, 0.4578275, 0.40821073]` and std
  `[0.26862954, 0.26130258, 0.27577711]`.
- Text: input `text`, **int32** `[1,77]`, ids padded with 0 (padding doesn't change the output).
- Outputs: `embedding` `[1,512]`, already L2-normalised. Stored as fp16 like today.
- Index entry tag `m`: `laionb32+yunet23+sface21/1` (with faces) or `laionb32/1` (without). MobileCLIP keeps
  `mcs2+yunet23+sface21/2` / `mcs2/2`.
- Text search ranks like Immich's smart search: every photo with an entry for the active model, best match first, no
  cut-off, shown page by page as you scroll (the first 200, then more). Filters (people, years, months, favorites,
  videos) narrow the ranked list instead of being separate results. This applies to both models and to every client.
- A cautionary note on provenance: LAION-5B was withdrawn in December 2023 after abusive material was found in it and
  re-released cleaned in 2024; this checkpoint was trained before that. Its weights remain openly distributed.

## Pipeline (`mobile/modules/cf-native/.../Vision.kt`)

- **Image vector:** the decrypted preview (2048 px) is scaled so its short side is 256 px, centre-cropped to
  256 × 256, RGB in 0..1, through the image encoder; L2-normalised 512 numbers.
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
- **Search by what is in a photo:** the browser downloads the active model's text encoder and the tokenizer once from
  Hugging Face (`web/src/search/content.worker.ts`; ONNX Runtime Web in a worker, checked against the same SHA-256,
  kept in the browser's cache), turns the words into a vector and ranks the stored image vectors, as the apps do.
  Account › Search shows the model and, for people an admin allowed it, the "Explicit search" switch for the account.
  Sign-out deletes the cached models.
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
  once), then downloads the models if needed, fetches the entries other devices made,
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

- **Exact duplicates:** items with the same file name (ignoring case), size and capture time. The metadata holds no
  content hash, so this is the strongest signal there is. Videos and other files count too.
- **Similar photos:** photos whose image vectors (the search index above, of the model the account searches with)
  have a cosine of at least 0.92 and that were taken at most 5 minutes apart: bursts and near-identical series. Every
  photo in a group is that close to every other one (complete linkage), so a slow series is never chained into one
  big group. Photos are sorted by capture time and each is compared only with the next 24 within the window, so a
  library of 50,000 needs well under a million comparisons. Only one copy of an exact duplicate takes part. Photos
  without an entry yet are left out ("Index more photos to find more"); with search off, only exact duplicates.
- **Which to keep:** the highest resolution, then the largest file, then one with a location, then the earliest
  upload. All others in a group are chosen for the trash; the person can change that. Items that couldn't be verified
  and the trash are never included. The public demo shows the groups but can't move anything.

The grouping is one module shared by both apps (`web/src/cleanup/duplicates.ts`, `@cleanup` on Android). The web app
scores the pairs in its search worker; on Android the native index scores them (`indexScores`), so the vectors never
leave native memory. The Mac app doesn't have it yet.

Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.
