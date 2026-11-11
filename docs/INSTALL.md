# Download and install Cipherfilm

Everything is on the **[latest release](https://github.com/basmatiactivist/cipherfilm/releases/latest)**. The file
names carry the version (`X.Y.Z` below). Every release has a `SHA256SUMS` file to check your download:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing      # macOS and Linux
```

`SHA256SUMS` comes from the same place as the files, so it shows a download is complete, not who made it. Files
built by the release workflow also carry a signed build provenance; with the GitHub CLI:
`gh attestation verify cipherfilm-android-X.Y.Z.apk --repo basmatiactivist/cipherfilm`.

You need a **server** first; the apps connect to it. The Android app is also in a closed test on Google Play (below).

## Server (Docker)

One folder, one file. You need a machine with Docker (Linux or macOS, amd64 or arm64) and HTTPS in front: any
reverse proxy (Caddy, nginx, Traefik, a Cloudflare Tunnel, Tailscale Serve, …).

```bash
mkdir cipherfilm && cd cipherfilm
curl -fsSLO https://raw.githubusercontent.com/basmatiactivist/cipherfilm/master/compose.yaml
echo "PUBLIC_HOSTS=photos.example.com" > .env      # the name your proxy serves
docker compose up -d
docker compose logs app | grep "FIRST-TIME SETUP"
```

Point your proxy at `http://127.0.0.1:8080` ([what it must do](SELF-HOSTING.md#deploy)). Open
`https://photos.example.com`, paste the token from the last line and create the first account.
**Update:** `docker compose pull && docker compose up -d` in the same folder.

The image is `ghcr.io/basmatiactivist/cipherfilm:2`: it follows every 2.x release, so `docker compose pull` always
gets the newest. To pin one version, set `CIPHERFILM_IMAGE=ghcr.io/basmatiactivist/cipherfilm:X.Y.Z` in `.env`.
Backups, settings and building from source:
[SELF-HOSTING.md](SELF-HOSTING.md).

## Web app

Nothing to install: open your server's address in a current browser on a computer, phone or tablet. This is also how
to use Cipherfilm on iPhone and iPad; there is no iOS app yet.

## Android

For Android 7 or newer on a 64-bit ARM phone (nearly every recent phone). Three ways: the APK by hand,
the APK through Obtainium (updates on their own), or the Google Play closed test.

File: `cipherfilm-android-X.Y.Z.apk`.

1. Open the latest release on the phone and download the APK.
2. Open the downloaded file. Android asks whether your browser or file manager may install apps; allow it.
3. Install, open Cipherfilm and enter your server's address.

Account (in the app) shows the app's and the server's version, sets fingerprint unlock and when the app locks itself
(immediately, or after 1, 5 or 15 minutes away; optionally also when the screen turns off), and has Delete account.

**Updates:** download the APK of the newer release and install it over the app.

### With Obtainium (updates on their own)

[Obtainium](https://obtainium.imranr.dev/) installs apps straight from their GitHub releases and keeps them up to date,
without an app store.

1. Install Obtainium (from its website, F-Droid or GitHub).
2. In Obtainium, tap **Add app** and enter `https://github.com/basmatiactivist/cipherfilm`, or open
   [obtainium://add/https://github.com/basmatiactivist/cipherfilm](obtainium://add/https://github.com/basmatiactivist/cipherfilm)
   on the phone.
3. Tap **Install**. Obtainium checks for new releases and offers each update.

### Google Play (closed test)

The Play build is in a closed test for now. Join the testers' group
[groups.google.com/g/cipherfilm-testers](https://groups.google.com/g/cipherfilm-testers) with your Google account,
then open [play.google.com/apps/testing/app.cipherfilm](https://play.google.com/apps/testing/app.cipherfilm) on the
phone (or in a browser signed in to the same account), tap **Become a tester** and install Cipherfilm from Play. Play
installs updates from then on.

### Google Play or the APK?

The same app, with three differences Google Play's rules require:

| | Google Play | APK (GitHub, Obtainium) |
|---|---|---|
| Explicit search | not offered: search always leaves explicit photos out | offered where the server's admin allows it (docs/SEARCH.md) |
| Automatic backup | in short background runs that continue in the next one; a video too large for one waits for **Back up now** (the app says so), which runs until it is done | runs until it is done, also in the background |
| Battery optimisation | opens Android's list, you pick Cipherfilm | asks directly |
| Updates | through Google Play | through Obtainium, or a new APK by hand |

Photos are backed up the same way by both. For large videos and long uploads the APK is more convenient: it runs until
everything is up, also with the app closed, while the Play build needs a tap on Back up now for a video too large for
one background run. Both are signed with the same key (Google Play signs with it too), so you can switch between them
without uninstalling: each installs as an update over the other.

### Checking the signature

Every APK is signed with the same key. To check it, compare the certificate's SHA-256 (Obtainium shows it, or use
[AppVerifier](https://github.com/soupslurpr/AppVerifier)) with
`87:D9:E9:AB:85:5B:03:E7:D7:D3:15:2F:5A:76:A4:D8:AF:B5:D3:8E:FC:A3:B9:93:2A:D9:3F:1B:A1:7C:67:12`.

## Mac

File: `cipherfilm-mac-X.Y.Z.zip`, for Macs with Apple silicon and macOS 15 or newer. On Intel Macs, use the web app.

1. Download the zip, open it and move **Cipherfilm** to **Applications**.
2. Open it. The app is not signed and notarised by Apple yet, so macOS stops the first start.
3. Open **System Settings › Privacy & Security**, scroll down and choose **Open Anyway** next to Cipherfilm. Confirm
   with your password. After that it starts normally.

**Updates:** quit the app and replace it in Applications with the newer one. If macOS stops it again, repeat step 3.

## Tools (optional)

| File | What for |
| --- | --- |
| `cipherfilm-upload-darwin-arm64` / `-amd64` | Uploads a big folder from a Mac, encrypted, from the command line ([TOOLS.md](TOOLS.md#uploading-a-large-folder-from-a-mac)). |
| `cipherfilm-decrypt-<os>-<arch>` | Restores your originals from the server's data folder or a backup, without the app ([TOOLS.md](TOOLS.md#getting-your-photos-back-without-the-app)). macOS, Linux and Windows. |

On macOS, a downloaded tool is blocked the first time, like the app. Make it executable and allow it once:

```bash
chmod +x cipherfilm-decrypt-darwin-arm64
xattr -d com.apple.quarantine cipherfilm-decrypt-darwin-arm64
```

## Coming later

The Android app on Google Play for everyone (after the closed test), and a Mac app signed and notarised by Apple.
