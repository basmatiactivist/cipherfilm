# Download and install Cipherfilm

Everything is on the **[latest release](https://github.com/basmatiactivist/cipherfilm/releases/latest)**. The file
names carry the version (`X.Y.Z` below), so take the newest one there. Every release also has a `SHA256SUMS` file to
check your download:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing      # macOS and Linux
```

`SHA256SUMS` comes from the same place as the files, so it shows a download is complete, not who made it. Files
built by the release workflow also carry a signed build provenance; with the GitHub CLI:
`gh attestation verify cipherfilm-android-X.Y.Z.apk --repo basmatiactivist/cipherfilm`.

You need a **server** first; the apps connect to it. None of the apps is in a store yet, so they are installed from
the files below.

## Server (Docker)

One folder, one file, one command. You need a machine with Docker (Linux or macOS, amd64 or arm64), a DNS name
pointing at it, and ports 80 and 443 open. HTTPS comes automatically from Let's Encrypt.

```bash
mkdir cipherfilm && cd cipherfilm
curl -fsSLO https://raw.githubusercontent.com/basmatiactivist/cipherfilm/master/deploy/quickstart/compose.yaml
echo "DOMAIN=photos.example.com" > .env
docker compose up -d
docker compose logs app | grep "FIRST-TIME SETUP"
```

Open `https://photos.example.com`, paste the token from the last line and create the first account.
**Update:** `docker compose pull && docker compose up -d` in the same folder.

The image is `ghcr.io/basmatiactivist/cipherfilm`: `:2` (the default here) follows every 2.x release, `:X.Y.Z` pins
one version (`CIPHERFILM_TAG=X.Y.Z` in `.env`). For private use without open ports (Tailscale) or behind a proxy you
already run, use the full setup in the [README](../README.md#choose-how-to-deploy).

## Web app

Nothing to install: open your server's address in a current browser, on a computer, a phone or a tablet. This is also
the way to use Cipherfilm on an iPhone or iPad; there is no iOS app yet.

## Android

File: `cipherfilm-android-X.Y.Z.apk`, for Android 7 or newer on a 64-bit ARM phone (nearly every phone of the last
years).

1. Open the latest release on the phone and download the APK.
2. Open the downloaded file. Android asks whether your browser or file manager may install apps; allow it.
3. Install, open Cipherfilm and enter your server's address.

**Updates:** download the APK of the newer release and install it over the app.

## Mac

File: `cipherfilm-mac-X.Y.Z.zip`, for Macs with Apple silicon and macOS 15 or newer. Intel Macs are not supported by
the app; use the web app there.

1. Download the zip, open it and move **Cipherfilm** to **Applications**.
2. Open it. The app is not signed and notarised by Apple yet, so macOS stops the first start.
3. Open **System Settings › Privacy & Security**, scroll down and choose **Open Anyway** next to Cipherfilm. Confirm
   with your password. After that it starts normally.

**Updates:** quit the app and replace it in Applications with the newer one. If macOS stops it again, repeat step 3.

## Tools (optional)

| File | What for |
| --- | --- |
| `cipherfilm-upload-darwin-arm64` / `-amd64` | Uploads a big folder from a Mac, encrypted, from the command line ([README](../README.md#uploading-a-large-folder-from-a-mac)). |
| `cipherfilm-decrypt-<os>-<arch>` | Restores your originals from the server's data folder or a backup, without the app ([README](../README.md#getting-your-photos-back-without-the-app)). macOS, Linux and Windows. |

On macOS, a downloaded tool is blocked the first time like the app. Make it executable and allow it once:

```bash
chmod +x cipherfilm-decrypt-darwin-arm64
xattr -d com.apple.quarantine cipherfilm-decrypt-darwin-arm64
```

## Coming later

Signed versions in Google Play and the Mac App Store. This page will say so when they exist.
