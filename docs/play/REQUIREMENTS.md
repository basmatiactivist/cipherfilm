# Publishing Cipherfilm on Google Play: requirements checklist

Researched 2026-11-05 against the official Play Console Help, Play policy and Android Developers pages linked in each section. Play rules change often, so check every date-bound item again in Play Console before submitting.

App facts this checklist is written for (from `mobile/app.json`, `mobile/app.config.js`, `mobile/android/app/src/main/AndroidManifest.xml`, `mobile/modules/cf-native/android/src/main/AndroidManifest.xml`, the library manifests and `.github/workflows/android.yml`):

| Item | Current value |
|---|---|
| Package | `app.cipherfilm` |
| Expo / RN | Expo SDK 58, React Native 0.88.1 |
| compileSdk / targetSdk / minSdk | 37 / **36** / 24 (from RN's `libs.versions.toml` via the Expo root-project plugin) |
| NDK | 27.1.12297006; `expo.useLegacyPackaging=true` (native libs compressed in the package) |
| Native libs | React Native/Hermes, `com.microsoft.onnxruntime:onnxruntime-android:1.31.1`, libsodium (via `Sodium.kt`), etc. |
| ABIs | CI builds `arm64-v8a` only (`-PreactNativeArchitectures=arm64-v8a`) |
| Build output | Signed **APK** (`assembleRelease`); there is no AAB build yet |
| versionCode | `major*1_000_000 + minor*1_000 + patch` |
| Release cert SHA-256 | `87d9e9ab855b03e7d7d3152f5a76a4d8afb5d38efca3b9932ad93f1ba17c6712` |

Merged permissions (app plus libraries):

| Permission | Source | Play declaration needed? |
|---|---|---|
| `INTERNET` | RN | no |
| `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` | app.json | **yes**: Photo and video permissions declaration |
| `READ_MEDIA_VISUAL_USER_SELECTED` | app.json | no (it's the partial-access path the policy wants) |
| `ACCESS_MEDIA_LOCATION` | app.json | no form; disclose in the privacy policy |
| `POST_NOTIFICATIONS` | app.json | no |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | app.json | **policy risk**, see §4.4 |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` (service `TransferService`, `foregroundServiceType="dataSync"`) | cf-native | **yes**: Foreground service declaration with video |
| `WAKE_LOCK` | cf-native, WorkManager | no |
| `RECEIVE_BOOT_COMPLETED` | expo-task-manager, WorkManager | no |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | expo-local-authentication | no |
| `VIBRATE` | app | no |
| Removed: `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, ONNX Runtime telemetry provider | blockedPermissions / `tools:node="remove"` | n/a |
| Not present (good): location, `MANAGE_MEDIA`, `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`, `USE_FULL_SCREEN_INTENT`, `com.google.android.gms.permission.AD_ID`, `QUERY_ALL_PACKAGES` | | |

> **Check:** `READ_EXTERNAL_STORAGE` is removed completely, but minSdk is 24. On Android 7–12 the app then has no permission to read the photo library, so backup can't work there. Either restore it with `android:maxSdkVersion="32"` (this is what Immich and Ente do) or raise minSdk to 33. Play's photo policy applies only to `READ_MEDIA_*`, so `READ_EXTERNAL_STORAGE` with maxSdk 32 doesn't add another declaration.

---

## 0. Developer account (decide this first: it determines whose name is public)

Sources: [Required information to create a Play Console developer account](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en), [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)

- [ ] **Personal account:** Google states it *"will display your legal name, your country (as per your legal address), and developer email address on Google Play"*. The full address is also shown if you monetize. **This puts the developer's real name on the store page, which breaks the "no real name anywhere" rule.** The *developer name* ("Cipherfilm") is shown as well, but the legal name still appears in the "App support / About the developer" section.
- [ ] **Organization account:** this needs a legal entity with a **D-U-N-S number**, an organization website and an organization phone number. Google shows the organization's *legal name, legal address, developer email and developer phone*. The person's name is not shown, as long as the entity's legal name doesn't contain it. (In Switzerland an *Einzelfirma* must include the owner's surname, so it doesn't solve the problem. A GmbH or a Verein does.) The D-U-N-S profile and the Google payments profile must match.
- [ ] EU Digital Services Act: Play Console asks for a **trader / non-trader** declaration. For traders, contact details (address, phone, email) are shown to EU users. A free, non-monetized open-source app from a non-business can usually declare non-trader. Confirm in Play Console.
- [ ] **Testing gate:** personal accounts created after 13 Nov 2023 need *"a minimum of 12 testers who have been opted in continuously for at least 14 days"* in a **closed test** before they can apply for production access. The production-access application (three parts: closed test, the app, production readiness) *"usually takes seven days or less"*. The help page states the rule for personal accounts only, so organization accounts aren't subject to it.
- [ ] Every account needs a verified developer email (published) and identity verification. Android developer verification is covered automatically for Play developers ([Play Console guide](https://developer.android.com/developer-verification/guides/google-play-console)).

**Recommendation:** the no-real-name requirement can only be met with an **organization account** for a legal entity whose name doesn't contain the developer's name. With a personal account, the legal name is published. That rules out a personal account unless that rule is relaxed.

---

## 1. Build and signing

### 1.1 Format: Android App Bundle (AAB)
- [ ] New apps must upload an **AAB**; APK uploads aren't accepted for new apps. Add a CI job that runs `./gradlew bundleRelease -PreactNativeArchitectures=arm64-v8a` (keep `assembleRelease` for the GitHub APK). The output is `android/app/build/outputs/bundle/release/app-release.aab`.
- [ ] Sign the AAB with the **upload key**, not the app signing key (see §1.2). `plugins/withReleaseSigning` needs a second signing config, or separate env vars, for the upload keystore.
- [ ] Optionally add `x86_64` to the AAB for Chromebooks and emulators. Play serves per-ABI splits, so this doesn't affect phone download size.

### 1.2 Play App Signing: which key signs what
Source: [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)

- With Play App Signing (required for AAB), Google signs the APKs users install with the **app signing key**. You sign uploads with an **upload key**, which Google can reset if it's lost.
- Default for new apps: *"automatically enrolled in quantum-ready, hybrid signing with Google-generated keys"* (RSA-4096 plus ML-DSA-65; older devices verify the classical signature).
- Opt-out: *"Advanced developers who want to manage their own key can change this default before a release is rolled out in the open testing or production track."* Under **Change key** you can *"Provide a copy of your app signing key"*, which is an encrypted export with Google's PEPK tool.
- Google recommends that the upload key and app signing key be different. It doesn't forbid using the same key, but don't.

Consequences for the GitHub APK channel and Obtainium:

| Option | Play-installed cert | GitHub APK cert | Effect |
|---|---|---|---|
| A. Google-generated app signing key | new Google key | `87d9e9ab…6712` | Two incompatible certificates. Users **can't switch** between Play and GitHub/Obtainium builds without uninstalling, and uninstalling wipes local state (`allowBackup=false`): sign-in, keys, backup progress. Obtainium users who installed from Play break when Obtainium tries to update from GitHub. For Android developer verification, the GitHub key must be registered separately in Play Console. |
| **B. Upload the existing release key as app signing key** (PEPK) + **new upload key** | `87d9e9ab…6712` | `87d9e9ab…6712` | One identity on both channels. Updates work across channels, and existing GitHub users can move to Play without reinstalling. The cost: Google holds a copy of the key, and you lose the default PQ-hybrid signing (key upgrade can still be requested later). |

- [ ] **Recommendation: option B.** On the first release, before anything goes to open testing or production, open *Setup → App signing → Change key → Provide a copy of your app signing key*. Export `release.p12` with PEPK. Generate a **new upload keystore** (RSA 4096, stored like the release key), register its certificate, and use it only for AAB uploads.
- [ ] Add the Play App Signing certificate fingerprints to anything that pins the cert (with option B nothing changes). Keep the GitHub APK signed with the release key as now.

### 1.3 Target API level
Source: [Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [ ] New apps and updates must target **Android 16 (API 36)**. The deadline was 31 Aug 2026, with extensions to 1 Nov 2026, and both have passed. **Cipherfilm targets 36: OK.**
- [ ] The next step (API 37, Android 17) is expected around Aug 2027. When the app targets 37, the Android 16 large-screen opt-out disappears (§1.6) and the READ_CONTACTS-style policy changes for API 37+ apply (not relevant here).

### 1.4 16 KB memory page size
Source: [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes)
- [ ] *"all apps targeting Android 15 (API level 35) and higher must support 16 KB memory page sizes on 64-bit devices on Google Play."* The page currently says that from **1 Feb 2027** updates that don't support it can't be released. Play Console already shows warnings. Treat it as a must-pass now.
- [ ] `useLegacyPackaging=true` means the `.so` files are compressed, so zip alignment doesn't matter. **ELF LOAD segments must still be aligned to 16 KB (`2**14`)**, and the RELRO end must be 16 KB-safe. Check every `.so` in the AAB/APK:
  - `check_elf_alignment.sh app-release.apk` (AOSP script), or `llvm-objdump -p lib.so | grep LOAD`, or the Android Studio APK Analyzer "Alignment" column.
  - `bundletool dump config --bundle=app-release.aab | grep alignment` should show `PAGE_ALIGNMENT_16K`.
- [ ] NDK r27 doesn't align to 16 KB by default (r28+ does). Make sure any code built by this project (RN/Expo modules with CMake) gets `-Wl,-z,max-page-size=16384`, or upgrade the NDK to r28+. ONNX Runtime 1.31.1 and RN 0.88 prebuilts should be aligned, but verify with the script.
- [ ] Test on a 16 KB emulator image (`adb shell getconf PAGE_SIZE` should return 16384) and make sure no "page size compat mode" dialog appears.

### 1.5 64-bit and versionCode
- [ ] 64-bit: an `arm64-v8a`-only build meets the 64-bit requirement. 32-bit-only devices simply aren't offered the app.
- [ ] versionCode must be strictly greater than every versionCode ever uploaded to the app, on any track, and at most 2,100,000,000. The scheme `major*1e6+minor*1e3+patch` works (e.g. 1.2.3 → 1002003). A rejected or replaced upload still uses up its versionCode, so a rebuild of the same version needs a new patch number. Pre-release tags (`1.2.0-rc1`) need a rule that maps them below the final release (today `split(/[.-]/)` produces `NaN` for `rc1`).

### 1.6 Android 16 behaviour that reviewers and tablets will hit (targetSdk 36)
Source: [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16)
- [ ] On displays with sw ≥ 600 dp (tablets, foldables, Chromebooks), **`screenOrientation="portrait"` is ignored**: the app will rotate and resize. Either test landscape and tablet layouts, or temporarily add `<property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY" android:value="true"/>` (this opt-out stops working at targetSdk 37).
- [ ] Edge-to-edge can't be opted out of. Predictive back is on by default (`enableOnBackInvokedCallback=true` is already set).
- [ ] Coming later: the local network permission (RFC1918 and CGNAT ranges; VPN interfaces such as Tailscale are excluded). Self-hosted users on `192.168.x.x` will be affected once it's enforced for a future targetSdk.

---

## 2. Store listing (Main store listing)

Sources: [Add preview assets](https://support.google.com/googleplay/android-developer/answer/9866151), [Metadata policy](https://support.google.com/googleplay/android-developer/answer/9898842)

| Field | Spec | Proposed value |
|---|---|---|
| App name | ≤ 30 chars; no emojis, "#1", "best", all caps, price or promotion | `Cipherfilm` (or `Cipherfilm – Encrypted Photos`, 28 chars) |
| Short description | ≤ 80 chars; no calls to action, superlatives or emojis | `End-to-end encrypted photo and video backup to your own server.` (63) |
| Full description | ≤ 4000 chars | Must say early and plainly: **requires your own Cipherfilm server** (link to the install guide), what's encrypted, auto-backup, on-device search, faces, biometric lock, free up space. **Don't mention** the explicit-content search model (§4.8). No real name. |
| App icon | 512×512, 32-bit PNG with alpha, ≤ 1024 KB, no badges or ranking text | export from `mobile/assets/icon.png` source |
| Feature graphic | 1024×500, JPEG or 24-bit PNG (**no alpha**); keep key elements out of the edges | required |
| Phone screenshots | 2–8 per device type; JPEG or 24-bit PNG (no alpha); each side 320–3840 px; long side ≤ 2× short side. **For recommendation eligibility: ≥ 4 screenshots at ≥ 1080 px (portrait ≥ 1080×1920)** | 4–8 portrait shots at 1080×1920 or 1080×2340 (≤ 2:1). Use demo data, no real faces of private people, nothing suggestive. |
| 7"/10" tablet screenshots | Optional. Large-screen screenshots: ≥ 4, 1080–7680 px, 16:9 or 9:16 | Skip at first. Add them only after the tablet layout is tested (§1.6). Without them the listing ranks lower on tablets but isn't rejected. |
| Video | Optional YouTube URL; public or unlisted, embeddable, ads off, not age-restricted | optional (you can reuse the FGS demo video, §4.3) |
| Category | App category | **Photography** (Immich and Ente use Photography; Tools also works) |
| Tags | up to 5, chosen from Google's list | e.g. Photo backup, Photo gallery, Cloud storage, Privacy |
| Contact email | required, **public** | e.g. `support@<project domain>`, a role address with no personal name |
| Website | optional for personal, required for organization | project site (e.g. GitHub Pages under `basmatiactivist` or own domain with WHOIS privacy) |
| Privacy policy URL | **required for every app** | `https://<site>/privacy`: public HTML, not a PDF, not geofenced (§4.6) |

Screenshot rules: they must show the real app experience and suit a general audience.

---

## 3. Testing tracks and timeline

Sources: [Testing requirements for personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en), [Review times](https://support.google.com/googleplay/android-developer/answer/9859751)

- [ ] **Internal testing:** up to 100 testers by email list, available within minutes. Use it first to check Play App Signing, the AAB, Play-delivered splits and the pre-launch report.
- [ ] **Closed testing:** email lists or Google Groups. For a personal account this is where the 12 testers × 14 continuous days happen, followed by the production-access application (≤ 7 days).
- [ ] Open testing (optional) → **Production**. Initial review: *"up to seven days or longer in exceptional cases"*, and new developer accounts get longer reviews. Updates are usually reviewed within hours to a few days.
- [ ] Use managed publishing, so that approved changes are released only when you click publish.
- [ ] Pre-launch report: robots can't reach a server. Either give them credentials (Testing → Pre-launch report → Settings → sign-in fields) or ignore the sign-in-only crawl.

---

## 4. Policy declarations (Policy → App content)

### 4.1 Privacy policy
Source: [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [ ] Linked in Play Console **and inside the app** (Settings/Account screen, and the sign-in screen).
- [ ] Must contain: the developer entity exactly as named on the store listing (or the app name), a privacy contact, the data types accessed, collected, used and shared, secure handling, and retention and deletion. It must be labelled as a privacy policy.
- [ ] Cipherfilm-specific content: the developer runs no service and receives no data. Everything goes to the server the user enters. Photos, videos, filenames, EXIF/GPS (`ACCESS_MEDIA_LOCATION`), capture dates, album names, the search index and the face list are end-to-end encrypted. The server operator can see email, sign-in times, counts and sizes, album structure and a device label (list from `docs/THREAT_MODEL.md`). ML runs on the device. Models are downloaded from the user's own server. There are no analytics, ads or crash reporting, and ONNX telemetry is removed. Biometric data never leaves the OS. Deletion is covered in §4.7.

### 4.2 Photo and video permissions (`READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`)
Source: [Details on Google Play's Photo and Video Permissions policy](https://support.google.com/googleplay/android-developer/answer/14115180)
- Only apps whose *"core functionality revolves around broad access to Photos and Videos"* may keep these permissions, for example gallery apps that are about *"managing and maintaining all of users' photos/videos"*. Everyone else must use the Android Photo Picker. The policy has been fully enforced since 28 May 2025. Immich and Ente are on Play with these permissions.
- [ ] Complete the declaration in App content. Draft text:

  > **Core functionality:** Cipherfilm is a photo and video backup and gallery app. Its core feature is automatic, continuous, end-to-end encrypted backup of the user's entire photo and video library to the user's own server, including photos taken after backup was turned on. It also lets the user free up space by removing originals that are safely backed up.
  > **Why the Photo Picker is not sufficient:** The picker grants access only to items the user selects each time. Automatic backup must detect and read new photos and videos in the background (WorkManager content-URI trigger on MediaStore) without user interaction, enumerate whole device folders the user chose to back up, and track which items are already backed up. None of this is possible with one-time picker selections. Users who grant only partial access (`READ_MEDIA_VISUAL_USER_SELECTED`) can still back up and view the items they selected; automatic backup of new photos is then unavailable.
- [ ] **Accommodate partial access:** the policy requires *"a reasonable effort to accommodate users who do not grant broad access"*. Check that the app works with "Allow limited access" (backs up the selected items and explains that auto-backup needs full access). Share-to-upload already works without any media permission.
- [ ] In-app prominent disclosure before the permission prompt (§4.5).

### 4.3 Foreground service declaration (`dataSync`)
Sources: [FGS requirements](https://support.google.com/googleplay/android-developer/answer/13392821), [FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types), [Android 15 FGS changes](https://developer.android.com/about/versions/15/behavior-changes-15)

- For each FGS type, the declaration needs: a description of the feature, the user impact if the task is deferred or interrupted, **a video link showing the steps a user takes to trigger the feature**, and a use case from Google's list.
- dataSync use cases on Play:
  - *Network transfer: upload or download*: *"The video must show a user starting an upload, download, sync…"*
  - *Network transfer: backup and restore*: *"Must be user-initiated. The video can't show fully automatic or background backup."*
  - *Local processing: other*: user-initiated local tasks only.
- `mediaProcessing` is for **transcoding** media to another format (*"Media transcoding"* use case). It **doesn't fit** uploads. Keep `dataSync`.
- Android 15+: dataSync FGS may run **6 h per 24 h** (the timer resets when the user opens the app), and may **not be started from `BOOT_COMPLETED`**. `TransferService.onTimeout` already stops the service: OK.

Findings in the code:
- `TransferService` (dataSync) is started by `keepRunning()` from three places: `src/upload.ts` (share-to-upload, which the user starts), `src/backup.ts` (backup runs, including **automatic** runs triggered by the WorkManager content-URI job in `NewMedia.kt`), and **`src/search/engine.ts` (on-device search indexing)**.
- [ ] **Search indexing in a dataSync FGS is a mismatch.** It's local ML processing, not a data transfer. Either run indexing only while the app is visible or in a plain (non-foreground) WorkManager job, or declare the use case *Local processing: other* and show in the video that the user starts indexing ("Turn on search"). Otherwise reviewers may reject the FGS declaration.
- [ ] Automatic background backup started without a user action is exactly what Google's backup use case excludes. Mitigation, the same pattern as Immich (WorkManager `SystemForegroundService` with `dataSync`): pick **"Network transfer: upload or download"**. Describe it as uploading photos *the user chose to back up*. Have the video show the user turning on backup for a folder, tapping "Back up now" and sharing a photo to Cipherfilm, with the notification and progress continuing after leaving the app. Consider using expedited WorkManager work (`setForeground` inside the worker) or user-initiated data transfer jobs ([UIDT](https://developer.android.com/develop/background-work/background-tasks/uidt), API 34+, `RUN_USER_INITIATED_JOBS`) for manual "Back up now" runs. UIDT is Google's recommended API for user-requested long transfers.
- [ ] Draft declaration text: *"Cipherfilm uploads the user's photos and videos, end-to-end encrypted, to the user's own server when the user backs up or shares items to the app. Uploads of large videos take minutes to hours and must not be interrupted when the user leaves the app. If deferred, the backup stays incomplete and the user's new photos are not protected; partially uploaded files must restart."*
- [ ] Record the video (unlisted YouTube or Drive link, 30–90 s): open the app → sign in to the demo server → turn on backup → tap Back up now → go to the home screen → show the "Backing up" notification with progress → completion. Add a second segment: share a photo from the Gallery to Cipherfilm.

### 4.4 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: high rejection risk
Source: [Doze exemptions / Play policy note](https://developer.android.com/training/monitoring-device-state/doze-standby#exemption-cases)
- *"Google Play policies prohibit apps from requesting direct exemption from Power Management features … unless the core function of the app is adversely affected."* The acceptable-use table covers messaging that can't use FCM, safety apps, task automation and peripheral companions. A backup app doesn't clearly qualify. Neither Immich nor Ente declares this permission.
- [ ] **Remove the permission from the Play build.** `BackupNative.askBatteryExemption` already falls back to `Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`, which needs **no permission**. Use only that path, with an explanation screen. Keep the direct dialog in the GitHub flavour if wanted, through a build-time switch in `app.config.js` (e.g. `CF_STORE=play`).

### 4.5 Prominent disclosure and consent (User Data policy)
- Required when data access may be unexpected, *"when the user is not engaging with your app"* (background photo access for auto-backup).
- [ ] An in-app screen **immediately before** the media permission prompt and before turning on auto-backup, in normal UI and not only in the privacy policy. It needs an explicit "Allow/Continue" button; dismissing or navigating away isn't consent. Suggested text:
  > *"Cipherfilm reads your photos and videos, including their location data, in the background to back them up automatically. Each file is encrypted on this phone before it is uploaded to the server you signed in to (https://…). The developer of Cipherfilm never receives your photos."* [Not now] [Continue]
- [ ] The same pattern applies to "Delete from phone after backup" (MediaStore trash requests already show the system confirmation).

### 4.6 Data safety form
Source: [Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- "Collect" means *transmitting data off the device*, whether to you or to anyone else. Exemptions: on-device processing, and **end-to-end encryption**: *"The encrypted data must not be readable by any intermediary entity, including the developer."* The help page doesn't address user-chosen self-hosted servers. To compare, Immich declares Photos, Videos and Device IDs as collected, Ente declares email, photos and videos plus crash logs, and Nextcloud declares nothing.
- [ ] Recommended answers (conservative, consistent with the E2E exemption):

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | **Yes** |
| Encrypted in transit? | **Yes** (the app refuses non-https servers, `session.ts`) |
| Way to request deletion? | **Yes** (§4.7) |
| Personal info → **Email address** | Collected, **not shared**, required, purposes: **App functionality, Account management**. Not processed ephemerally. |
| Photos and videos | **Not declared**: end-to-end encrypted, the server and developer can't read them (E2E exemption). Mention this in the privacy policy. |
| Location (EXIF GPS) | Not declared: inside the E2E-encrypted metadata only. |
| Device or other IDs | Not declared (the server stores only a UA-derived device label; no identifiers). Declare it if a device ID is ever added. |
| App activity / app info and performance / diagnostics | **None**: no analytics or crash SDK, ONNX telemetry removed. |
| Shared with third parties | None |
| Independent security review | No (unless one is done) |

- [ ] Re-check before each release that no SDK adds network calls (e.g. `expo-updates` is disabled, `expo.modules.updates.ENABLED=false`).

### 4.7 Account deletion
Sources: [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111), [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- It applies if *"a user can complete creating an app account directly in the app"* **or** the app *"directs the user to an app account creation flow outside of the app"*. Cipherfilm's sign-in screen says *"New here…? Use Cipherfilm in the browser for invites"*, which counts as directing to an outside creation flow. Self-hosted servers aren't exempt in the text (only accounts that are created and kept *offline* are). **Treat the requirement as applicable.**
- Requirements:
  - An **in-app** path to delete the account and its data (it may be a link to the web resource).
  - A **web URL** entered in Data safety, where users can request deletion without reinstalling the app. It must reference "Cipherfilm" (the app or developer name as shown on Play).
  - Deactivation or "freeze" doesn't count. Retained data must be disclosed.
- Today the server only supports admin deletion (`DELETE /api/admin/users/{id}`, CLI `delete-user`) and blocks deleting yourself.
- [ ] **Build:** `DELETE /api/me` (requires re-entering the password / `auth` proof; refuses for the last active admin), plus **Account → Delete account** in the mobile app and the web app. It deletes items, albums, index and blobs, then signs out every device.
- [ ] **Web page** `https://<site>/delete-account`: "Cipherfilm accounts live on the server your administrator runs; the Cipherfilm developer holds no account data. To delete your account: in the app, Account → Delete account; or in Cipherfilm in the browser; or ask your server administrator (they can run `/app delete-user EMAIL --yes`). Deletion removes all photos, videos, albums and search data from that server immediately. Backups of the server made by its administrator (e.g. Kopia) follow the administrator's retention."

### 4.8 Sensitive content: optional explicit-content search model
Source: [Sexual content and profanity policy](https://support.google.com/googleplay/android-developer/answer/9878810)
- The policy bans apps that *contain or promote* sexual content, and "undress / see-through" apps. A classifier that lets a user find their *own* photos isn't content, and the help page doesn't address it. The risk is a reviewer seeing an "explicit" toggle or label and judging it as promoting sexual content.
- [ ] It's already off unless an admin allows it (`me.user.nsfw`), and the demo server must **not** allow it. Reviewers then never see it.
- [ ] Neutral wording in the app: "Sensitive content detection: find or hide photos that may contain nudity" rather than "explicit search". No sample imagery, nothing in screenshots, listing or description.
- [ ] Safest: a Play build flag that removes the explicit model choice entirely (the GitHub build keeps it). Decide before submitting.
- [ ] Don't market it. If asked, the answer is: "on-device classifier over the user's own private library; no content is provided by the app."

### 4.9 Other App content items

| Item | Answer for Cipherfilm |
|---|---|
| **App access** | "All or some functionality is restricted" → add sign-in details (§5) |
| **Ads** | No ads |
| **Content rating (IARC)** | Category: *All other app types* (Utility/Productivity/Other). Violence, fear, sexuality, language, controlled substances, gambling: **No**. Users interact or exchange content with other users: **No** (no sharing between accounts; each library is private). Shares user's location with others: **No**. Digital purchases: **No**. Unrestricted web access: **No**. Expected: Everyone / PEGI 3 / USK 0. |
| **Target audience and content** | **18 and over** (or 16+; avoid any under-13 age groups so the Families policy doesn't apply). "Appeals to children": No. |
| **News app** | No |
| **Government app** | No |
| **Financial features** | "My app doesn't provide any financial features" |
| **Health apps declaration** | Required for every app: choose "My app does not have any health features" ([help](https://support.google.com/googleplay/android-developer/answer/14738291)) |
| **Advertising ID** | "No": the merged manifest has no `AD_ID` permission. Keep it that way, because a mismatch blocks releases. |
| **Photo and video permissions** | §4.2 |
| **Foreground service permissions** | §4.3 |
| **Data safety** | §4.6 |
| Exact alarms / full-screen intent / background location / `MANAGE_MEDIA` / `QUERY_ALL_PACKAGES` | not used, so no declarations |
| Families policy | not applicable (18+) |

Notifications: `POST_NOTIFICATIONS` needs no declaration. Request it when the user turns on backup, not at first launch.

---

## 5. Reviewer access: needs a public demo server

Sources: [App access](https://support.google.com/googleplay/android-developer/answer/9859455), [Requirements for sign-in credentials](https://support.google.com/googleplay/android-developer/answer/15748846)

- Credentials *"must be accessible at all times, reusable, and valid regardless of user location"*, in English, with no 2FA or OTP, plus *"clear instructions"* for special login fields. If a password expires, the app *"may be rejected"*.
- The production instance is **tailnet-only** (`photos.tail3b37f7.ts.net`), so reviewers can't reach it. Never give it to Google.
- [ ] Run a **dedicated demo instance** on a public HTTPS domain (e.g. `demo.<project-domain>`, Caddy with Let's Encrypt). A separate small VPS or a separate compose project with its own volume works, sharing nothing with production. Configuration:
  - one ordinary user, `reviewer@<domain>`, with a strong static password, no recovery dependency, and no admin rights;
  - about 30 pre-loaded neutral demo photos and videos (own or CC0, no identifiable private people), plus one album;
  - search models available (standard only), **explicit model disabled**, small quota (e.g. 2 GB);
  - a nightly reset job (restore a snapshot) so reviewer uploads don't pile up, with monitoring and an uptime alert.
- [ ] App access instructions (≤ 500 chars each field):
  > Cipherfilm is a client for a self-hosted server. On the sign-in screen enter Server: `https://demo.<domain>` · Email: `reviewer@<domain>` · Password: `<…>`. No 2FA. After sign-in, grant photo access and tap "Back up" to see encrypted backup; the demo library already contains sample photos. Biometric unlock is optional (Account → App lock).
- [ ] Add the same values to the pre-launch report credentials if the sign-in fields have stable resource IDs.
- [ ] The listing and description must make the server requirement obvious, with a link to `docs/INSTALL.md` on the website, to avoid a "minimum functionality / app doesn't work" rejection.

---

## 6. Other common rejection causes for comparable apps

- **Permissions without a matching core feature:** remove `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (§4.4). Keep `USE_FINGERPRINT` (harmless, comes from the library).
- **Declarations that don't match the code:** the FGS declaration must cover every `startForeground` path (backup, share-upload, search indexing). The Data safety answers must match the actual traffic.
- **Broken reviewer access:** demo server down, expired password, or tailnet-only URL (§5).
- **Missing prominent disclosure** for background media access (§4.5).
- **Account deletion URL** missing or not mentioning the app name (§4.7).
- **Privacy policy** missing from inside the app, a PDF, or not naming the listing entity (§4.1).
- **Code downloaded at runtime:** ONNX models are data, not executable code (fine). Keep `expo-updates` disabled in the Play build.
- **Store listing:** screenshots that don't show the real app, keyword stuffing, competitor names in the description ("Google Photos alternative" is a common reason for a metadata rejection; avoid naming other products).
- **16 KB / target SDK / AAB** checks fail at upload time, before review.
- **Personal-account testing gate:** fewer than 12 testers opted in continuously for 14 days.
- **Identity or name leaks:** Play publishes the account's legal name (personal) or the entity's legal name, address and phone (organization) (§0). Use a role email and a privacy-protected domain for the website and privacy policy.

---

## 7. What we must build / prepare

**Account and legal**
1. Decide the account type: an **organization** (legal entity with D-U-N-S, with no personal name in its legal name) to keep the real name off Play, or accept that a personal account shows the legal name. Register with a role email and phone. Declare DSA non-trader status if eligible.
2. Website on a privacy-protected domain with `/privacy` (§4.1), `/delete-account` (§4.7), support email and install guide.

**Code**
3. CI: an `bundleRelease` AAB job signed with a **new upload key**. Keep the GitHub APK signed with the existing release key.
4. Play App Signing: on the first upload, **provide the existing release key (PEPK export) as the app signing key** (option B), before any open or production release.
5. A Play build flavour switch (`CF_STORE=play` in `app.config.js`) that drops `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (uses the settings-screen fallback) and optionally removes the explicit-content model option.
6. Restore `READ_EXTERNAL_STORAGE` with `maxSdkVersion=32`, or raise minSdk to 33 (Android 7–12 currently can't read the library).
7. Move search indexing out of the dataSync FGS (plain WorkManager / foreground-only), or plan to declare it as *Local processing*.
8. An in-app **prominent disclosure** screen before the media permission and before enabling auto-backup. Request notifications at backup opt-in.
9. Make sure partial ("limited") photo access works and is explained.
10. **Account deletion:** server `DELETE /api/me` with re-authentication, plus "Delete account" in the mobile Account screen and the web app. Add a privacy-policy link in the app (sign-in and Account screens).
11. Verify 16 KB alignment of every `.so` (script plus 16 KB emulator). Fix the NDK/linker flags if any library is unaligned. Fix the pre-release versionCode mapping.
12. Test the tablet/landscape layout (Android 16 ignores portrait lock on large screens), or add the temporary opt-out property.

**Store assets and forms**
13. Icon 512×512 PNG, feature graphic 1024×500 (no alpha), 4–8 phone screenshots at 1080×1920 or larger from the demo library, title, short and full description stating "requires your own server".
14. FGS demo video (backup plus share-to-upload), unlisted on YouTube.
15. Fill in App content: privacy policy, app access, ads (no), content rating (IARC as in §4.9), target audience 18+, news/government/financial/health (none), advertising ID (no), Data safety (§4.6), photo/video declaration (§4.2), FGS declaration (§4.3).

**Infrastructure**
16. Public **demo server** with a reviewer account, demo library, explicit model off, nightly reset, uptime alert (§5). Keep it separate from the tailnet-only production VPS.

**Rollout**
17. Internal test → closed test (personal account: ≥ 12 testers, 14 continuous days, then the production-access application) → production with managed publishing. Allow 1–3 weeks for the first review cycle.
