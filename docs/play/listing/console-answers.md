# Play Console answers for Cipherfilm (`app.cipherfilm`)

Every form in Play Console, answered for this app, in the order the console shows them. Reasoning is under each
answer so it can be re-checked when the app changes. Background and sources: [../REQUIREMENTS.md](../REQUIREMENTS.md).
Listing texts: `en-US/` and `de-DE/` next to this file. Graphics: `../graphics/`.

Values used everywhere:

| | |
|---|---|
| App name / developer name on Play | Cipherfilm |
| Package | `app.cipherfilm` |
| Contact e-mail (public) | contact@cipherfilm.app |
| Website | https://cipherfilm.app |
| Privacy policy | https://cipherfilm.app/privacy (German: https://cipherfilm.app/de/datenschutz; Play takes one URL, use the English one) |
| Account deletion | https://cipherfilm.app/delete-account (page text: `delete-account-page.md`) |
| Demo server for review | https://demo.cipherfilm.app, `reviewer@cipherfilm.app` / `<set by owner>` |

No personal name goes into any field. The legal name shown by Play depends on the account type (REQUIREMENTS §0).

---

## 1. Create app

| Field | Answer |
|---|---|
| App name | `Cipherfilm: Encrypted Photos` (the store title; the launcher name stays "Cipherfilm") |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free |
| Declarations | Tick: Developer Program Policies; US export laws (the app uses standard encryption via libsodium, available as open source; see the export note at the end) |

---

## 2. Main store listing (Grow → Store presence → Main store listing)

| Field | en-US | de-DE (add via "Manage translations" → German – de-DE) |
|---|---|---|
| App name | `en-US/title.txt` | `de-DE/title.txt` |
| Short description | `en-US/short_description.txt` | `de-DE/short_description.txt` |
| Full description | `en-US/full_description.txt` | `de-DE/full_description.txt` |
| App icon | `../graphics/icon-512.png` (512×512, 32-bit PNG) | same |
| Feature graphic | `../graphics/feature-graphic-1024x500.png` | `../graphics/feature-graphic-de-1024x500.png` |
| Video | leave empty (`video.txt`) | leave empty |
| Phone screenshots | 8 framed shots, see `../graphics/SCREENSHOTS.md` | same raw shots, German captions |
| Tablet screenshots | skip for now (REQUIREMENTS §2, §1.6) | skip |

The full description uses `<b>…</b>` for section headings, which Play renders. Line breaks are kept. No emojis,
no superlatives, no other products or stores named. It says in the second paragraph that the app needs the user's
own Cipherfilm server and links the install guide.

Release notes ("What's new") per version: `en-US/changelogs/<versionCode>.txt` and `de-DE/changelogs/<versionCode>.txt`
(versionCode `major*1e6+minor*1e3+patch`, e.g. 2.1.3 → `2001003.txt`). The release workflow sends them to Play with
each upload (`mobile/scripts/play-notes.sh`, docs/RELEASING.md "Google Play from CI"); nothing to paste by hand.
`release_notes.txt` holds the 2.1.0 text of the first upload.

---

## 3. Store settings (Grow → Store presence → Store settings)

| Field | Answer | Why |
|---|---|---|
| App or game | App | |
| Category | **Photography** | A photo and video library with backup; comparable self-hosted photo apps use Photography. |
| Tags (up to 5) | Pick from Google's list, closest to: *Photo & video backup*, *Photo gallery*, *Cloud storage*, *Privacy* / *Security*, *Video* | The tag list changes; choose the nearest existing ones. Don't pick tags for features the app lacks (editing, filters, social). |
| Contact e-mail | contact@cipherfilm.app | Role address, no personal name. |
| Phone | leave empty | Optional. (An organization account has a phone in its *account* profile, which Play may show anyway; REQUIREMENTS §0.) |
| Website | https://cipherfilm.app | |
| External marketing | Off (opt out) | No ads anywhere. Optional; on is harmless. |

---

## 4. App content (Policy → App content)

### 4.1 Privacy policy

- URL: `https://cipherfilm.app/privacy`
- The page has the app section (`privacy-policy-changes.md`). The app links it on the connect screen (before sign-in)
  and under Account › About, since 2.1.8 (REQUIREMENTS §4.1).

### 4.2 App access

- Choose: **All or some functionality in my app is restricted.**
- Add instructions → one entry:

| Field | Value |
|---|---|
| Name | Demo server sign-in |
| Username | `reviewer@cipherfilm.app` |
| Password | `<set by owner>` |
| Any other information required to access your app | see below (≤ 500 characters, this text is 464) |

```text
Cipherfilm is the app for a self-hosted server, so it first asks for a server address.
1. Open the app. Address: demo.cipherfilm.app, tap Connect.
2. E-mail and password above, tap Sign in. No 2FA, no code.
3. Fingerprint unlock is offered: tap Not now (or Turn on).
4. The library has sample photos. Search tab: try "beach". Backup tab: choose folders, Back up now.
The account is reset every night. Photos are encrypted on the device; the server cannot see them.
```

- Tick "Allow Android to use the credentials you provide for performance and app compatibility testing" (only if
  the pre-launch robot can get past the address screen; otherwise leave it and ignore the sign-in-only crawl).
- Owner to do before submitting: create the account on the demo server with a static strong password that never
  expires, fill it in here, and check the steps above on a clean install.

### 4.3 Ads

- **No, my app does not contain ads.** No ad SDK, no house ads, no sponsored content.

### 4.4 Content rating (IARC questionnaire)

| Step | Answer |
|---|---|
| E-mail address for the rating | contact@cipherfilm.app |
| Category | **All Other App Types** (Utility, Productivity, Communication, or Other) |

Questions for that category:

| Question | Answer | Why |
|---|---|---|
| Violence (any depiction, realistic or fantasy) | No | The app ships no content. It shows only the user's own photos. |
| Fear / horror content | No | Same. |
| Sexuality, nudity, sexual references | No | Same. The Play build has no explicit-content search option, and nothing in the app or listing refers to it. |
| Language (profanity, crude humour) | No | |
| Controlled substances (drugs, alcohol, tobacco) | No | |
| Gambling, simulated gambling, real-money betting | No | |
| Does the app natively allow users to interact or exchange content with other users (chat, sharing images, voice)? | **No** | Each account's library is private. There is no sharing between users, no comments, no messaging. "Share to Cipherfilm" uploads from the phone into the user's own library only. |
| Does the app share the user's current physical location with other users? | No | Location is read only from photo EXIF, encrypted on the device, and never shown to other users. The optional map (docs/MAP.md) loads map images from OpenFreeMap: see Data safety, Approximate location. |
| Does the app allow users to purchase digital goods? | No | Free, no in-app purchases. |
| Does the app contain any swastikas or other hate symbols? (some questionnaire versions) | No | |
| Is the app a web browser or search engine / provides unrestricted internet access? | No | It connects only to the one server the user signs in to, and once to Hugging Face to download the open search models. "Search" is a local search of the user's own photos. |
| Is this a news or educational product? (if asked) | No | |

Expected result: ESRB Everyone, PEGI 3, USK 0, IARC 3+, ClassInd L.

### 4.5 Target audience and content

| Question | Answer | Why |
|---|---|---|
| Target age groups | **18 and over** only | It is a tool for adults who run or use a self-hosted server and manage their own encryption keys and recovery key. No group under 13 is selected, so the Families policy does not apply. (16–17 could be added later without Families consequences, but 18+ is the clean, conservative choice.) |
| Could your store listing unintentionally appeal to children? | No | Neutral design, no characters or child-oriented imagery. |
| Ads | (already answered: none) | |

### 4.6 News app

- **No.** It is not a news app.

### 4.7 COVID-19 contact tracing and status apps (if still shown)

- My app is not a publicly available COVID-19 contact tracing or status app.

### 4.8 Data safety

Principle for every answer: "collected" in Play's sense means data the app sends off the device. Cipherfilm sends
data only to the server the user signs in to, which the user (or their administrator) runs. The developer runs no
service and receives nothing. Data that leaves the device **end-to-end encrypted** so that no intermediary,
including the server and the developer, can read it, is exempt from disclosure ("The encrypted data must not be
readable by any intermediary entity, including the developer"). Everything else that the user's server can read is
declared. This matches REQUIREMENTS §4.6.

#### Overview

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | The sign-in e-mail address goes to the user's server in readable form. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | The app only talks to `https://` servers and refuses plain http (`mobile/src/session.ts`; the model download too). |
| Which of the following methods of account creation does your app support? | **Username and password** (accounts are created through an invite link from the server's administrator, in the browser) | The app itself only signs in; the sign-in screen points new users to the web app for invites, which counts as directing to account creation (REQUIREMENTS §4.7). |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In the app (Account → Delete account), in the web app, and via the server's administrator. |
| Delete account URL | `https://cipherfilm.app/delete-account` | Public page, names "Cipherfilm", explains the steps. Content in `delete-account-page.md`. |
| Do you provide a way for users to request that *some or all* of their data is deleted without deleting the account? (if asked) | **Yes** | Users delete photos, videos and albums in the app; trash is emptied after 30 days or immediately with "Empty trash"; search data is removed with the item. |

#### Data types

| Category → type | Collected? | Shared? | Details |
|---|---|---|---|
| Personal info → **Email address** | **Yes** | No | Required (not optional). Purposes: **App functionality**, **Account management**. Not processed ephemerally. It is the sign-in name on the user's server; Cipherfilm never sends e-mail. |
| Personal info → Name | No | No | Names given to people in photos are encrypted on the device (E2E exemption). |
| Personal info → User IDs | No | No | The server identifies the account by the e-mail address (declared above). Internal random row ids are not tied to anything outside that server. *If a reviewer questions this, declaring "User IDs, App functionality, Account management" is the conservative fallback.* |
| Personal info → address, phone, race/ethnicity, political or religious beliefs, sexual orientation, other info | No | No | |
| Financial info (all) | No | No | No payments. |
| Health and fitness (all) | No | No | |
| Messages (all) | No | No | |
| **Photos and videos** → Photos, Videos | **No** (exempt) | No | Encrypted on the phone with a per-file key before upload. The keys are locked with the user's password or recovery key, which never leave the device. Neither the server operator nor the developer can decrypt them. This is exactly the E2E exemption. |
| Audio files, voice recordings, music | No | No | Videos are uploaded as files, end-to-end encrypted (as above). |
| Files and docs | No | No | |
| Calendar, Contacts | No | No | |
| **Location** → Approximate | **Yes**, optional, App functionality, not shared, not ephemeral | No | GPS positions exist only inside photo EXIF, encrypted on the device with the photo; that part is exempt. But the optional map (off until the person turns it on, docs/MAP.md) requests map images from OpenFreeMap (via Cloudflare): the areas viewed, and at district level (zoom 11) the area of a photo whose details are opened. That is approximate location sent to a third party. Entered in the Console on 2026-11-09. |
| **Location** → Precise | **No** | No | The small map never goes past zoom 11 and can't be zoomed; the map tab's areas are chosen by the person. The app requests no location permission. |
| Web browsing history | No | No | |
| App activity → App interactions, in-app search history, installed apps, other UGC, other actions | No | No | Search runs on the phone; the search index and people list are encrypted on the device before they are stored. The server keeps upload and sign-in times as part of operating the user's account on the user's own server; they are not sent to the developer. *Conservative fallback if a reviewer asks: "App interactions, App functionality".* |
| Search models from Hugging Face (not a data type; for the reviewer's notes) | No | No | When the user turns search on and agrees in a question that names the download's size, Hugging Face and what it sees, the app downloads the open search models once from Hugging Face (`huggingface.co`, its CDN under `hf.co`), where they are published. It is a plain download of public files: no user data, account, photo, search word or identifier is sent; Hugging Face sees only the phone's IP address, as any server it connects to does. Each file is checked against a SHA-256 built into the app. Not "sharing" under Play's definition (no user data leaves the app). |
| App info and performance → Crash logs, Diagnostics, Other | No | No | No crash reporting or analytics SDK. ONNX Runtime telemetry is removed from the manifest. |
| Device or other IDs | No | No | No advertising ID (`AD_ID` not in the manifest), no Android ID. The server stores only a readable device label, the phone's model name ("Pixel 8 (Android app)"), so the user can sign out a device. |

#### Security practices summary shown on the listing

- Data is encrypted in transit: Yes.
- You can request that data be deleted: Yes.
- Independent security review: **No** (none has been done; do not tick).
- Committed to Play Families Policy: not applicable.

Before each release: check that no new dependency adds network calls (`expo-updates` stays disabled; the only
other host is Hugging Face for the models, `server/models.json`), that the
merged manifest still has no `AD_ID`, and that these answers still match.

### 4.9 Government apps

- **No.** Not developed by or on behalf of a government.

### 4.10 Financial features

- **My app doesn't provide any financial features.**

### 4.11 Health

- **My app does not have any health features.**

### 4.12 Advertising ID

- **No**, the app does not use an advertising ID. (The merged manifest has no
  `com.google.android.gms.permission.AD_ID`. If a library ever adds it, remove it with `tools:node="remove"` or the
  release is blocked.)

### 4.13 Photo and video permissions (`READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`)

Choose the core-functionality option for **photo/video gallery and backup** ("Your app's core functionality
requires broad access to photos and videos"). Then:

**Describe your app's core functionality that requires these permissions** (short version, 242 characters, for a
250-character field):

```text
Cipherfilm is a photo and video backup and gallery app. It automatically backs up the user's whole photo and video library, end-to-end encrypted, to the user's own server, including new photos, and frees up space once originals are backed up.
```

Longer version, if the field allows ≤ 500 characters (436):

```text
Cipherfilm is a photo and video backup and gallery app. Its core feature is automatic, continuous, end-to-end encrypted backup of the user's entire photo and video library to the user's own server, including photos taken after backup was turned on. It also frees up space by removing originals that are safely backed up. Users who allow only selected photos can still back those up; automatic backup of new photos then is not available.
```

**Why the Android Photo Picker is not sufficient** (≤ 500 characters, 438):

```text
The picker only grants access to items the user selects each time. Automatic backup must detect and read new photos and videos in the background without user interaction (WorkManager content-URI trigger on MediaStore), read whole device folders the user chose to back up, and track which items are already backed up so that space can be freed. None of this works with one-time picker selections. Share-to-upload needs no media permission.
```

The in-app prominent disclosure before the permission prompt (REQUIREMENTS §4.5) and the "limited access" path are
in the app since 2.1.0.

### 4.14 Foreground service permissions (`FOREGROUND_SERVICE_DATA_SYNC`)

Service: `TransferService`, type `dataSync`.

| Field | Answer |
|---|---|
| Foreground service type | Data sync |
| Use case | **Network transfer: upload or download** |
| Description of the feature (≤ 500 characters; 419) | see below |
| Impact if the task is deferred or interrupted (≤ 500 characters; 305) | see below |
| Video link | unlisted YouTube link to the recording described below |

Description:

```text
Cipherfilm uploads the user's photos and videos, end-to-end encrypted, to the user's own server when the user taps "Back up now" or shares items to the app. A single video can be several gigabytes and takes minutes to hours to upload. The foreground service shows a notification with the upload's progress and keeps the transfer running when the user leaves the app; it stops as soon as the upload is done.
```

User impact if deferred or interrupted:

```text
If the upload is deferred, the user's new photos and videos are not backed up and are not protected if the phone is lost. If it is interrupted, partly uploaded large videos must restart, which wastes the user's data and battery, and the user cannot free up space on the phone until the backup is complete.
```

> Since 2.1.8 the Play build starts this service only for transfers the user starts ("Back up now", a share): automatic
> backups of new photos run in plain WorkManager runs and continue in the next run (a file too large for one waits for
> "Back up now"), as Google's "backup and restore"
> example asks (a daily auto backup is not the user-initiated case).

> Resolved in 2.1.0 (REQUIREMENTS §4.3): search indexing no longer runs in this service. Besides backup and
> share-to-upload it carries only the download of the search model (from Hugging Face), which is a download
> and fits the same use case.

#### Demo video script (30–60 s, portrait screen recording, no audio needed)

Record on a phone or emulator with `adb shell screenrecord --size 1080x1920 /sdcard/fgs.mp4` (3 min max), signed in
to the demo server, with demo photos in the phone's gallery. Upload to YouTube as **Unlisted**, embedding allowed,
not age-restricted, no ads. Add on-screen text (or the YouTube description) for each step.

| Time | What the screen shows | On-screen caption |
|---|---|---|
| 0–5 s | Home screen, tap the Cipherfilm icon. The app opens on Photos. | "User opens Cipherfilm" |
| 5–15 s | Tap **Backup**. Choose a folder (e.g. Camera), turn on **Back up automatically**. If asked, the prominent disclosure appears; tap **Continue**, then allow photo access and notifications. | "User chooses folders and turns on backup" |
| 15–20 s | Tap **Back up now**. Progress starts on the Backup screen. | "User starts the upload" |
| 20–30 s | Press Home. Pull down the notification shade: the Cipherfilm "Backing up" notification with a progress bar, counting up. | "Upload continues in a foreground service while the app is in the background" |
| 30–38 s | Wait (or cut) until the notification says the backup is done; the notification goes away / shows "Backup done". | "Service stops when the upload is done" |
| 38–55 s | Open the Gallery (or Files) app, select a photo or video, tap **Share → Cipherfilm**, confirm the upload. Press Home and show the "Uploading" notification with progress, then "Upload done". | "User shares a video to Cipherfilm: same upload service" |

Do not show automatic backup starting by itself in the background: the chosen use case requires the user to start
the transfer. Use the demo account only.

### 4.15 Other declarations

| Item | Answer |
|---|---|
| Exact alarms, full-screen intent, background location, `MANAGE_MEDIA`, `QUERY_ALL_PACKAGES`, accessibility, VPN | Not used: no declaration appears. |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Not in the Play build (`CF_STORE=play`; `mobile/scripts/check-play-manifest.sh` fails the build if it is in the merged manifest). REQUIREMENTS §4.4. |
| Families policy | Not applicable (18+). |
| EU Digital Services Act: trader status | Non-trader, if the account is not a business (free, no monetization); otherwise trader with the organization's public contact details (REQUIREMENTS §0). Owner decides. |

---

## 5. Export compliance note

The app uses standard, publicly available encryption (libsodium: XChaCha20-Poly1305, X25519, Argon2id) for
data protection, and the source is published under AGPL-3.0. Play shows the US export-laws checkbox at app
creation; there is no separate encryption form on Play. (Distribution in France formerly needed a declaration for
encryption software; publicly available open-source encryption is generally exempt. Owner to confirm if French
distribution is a concern.)

---

## 6. Pre-launch report (Testing → Pre-launch report → Settings)

- Credentials: only if the address, e-mail and password fields have stable resource IDs. Address field:
  `demo.cipherfilm.app`; e-mail `reviewer@cipherfilm.app`; password `<set by owner>`.
- Otherwise leave it off; the robot will only see the address screen, which is expected for a client app.
