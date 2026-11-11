import type { ViewProps } from "react-native";
import { NativeModule, requireNativeModule, requireNativeView } from "expo";

type Bytes = Uint8Array;

export interface BackupState {
  online: boolean; unmetered: boolean; charging: boolean; battery: number; batteryExempt: boolean; powerSave: boolean;
  /** the person chose "Restricted" for the app's battery use (Android 9+): Android stops its background work */
  backgroundRestricted: boolean;
  media: "full" | "partial" | "none"; location: boolean; notifications: boolean; sdk: number;
}

/** clips: one image vector per model asked for, in that order; faces found once */
export interface Analysis { clips: Bytes[]; faces?: { box: number[]; score: number; emb: Bytes }[] }
export interface Hit { id: string; score: number }
export interface FaceGroup { person: string | null; faces: string[]; items: string[]; cover: { key: string; item: string; box: number[] } | null }
export interface PhoneMedia { id: number; uri: string; name: string; size: number; mime: string; bucket: string; folder: string; taken: number }

declare class CfNativeModule extends NativeModule<{ onModelProgress: (e: { path: string; done: number; total: number }) => void; onShake: () => void; onLockDue: (e: { why: "timer" | "screen" }) => void }> {
  // shake to lock and close (Shake.kt)
  shakeWatch(on: boolean): void;
  closeApp(): void;
  // screenshots, screen recordings and the recent-apps preview (ScreenGuard.kt): blocked unless allowed; this
  // phone's setting, applied to the window at once and at every launch before the first frame
  screenshotsAllowed(): boolean;
  allowScreenshots(on: boolean): void;
  // automatic lock (AutoLock.kt): onLockDue after lockAfter(ms), and at screen off while watchScreen(true)
  lockAfter(ms: number): void;
  lockCancel(): void;
  watchScreen(on: boolean): void;
  // libsodium, see android/.../Sodium.kt
  sodium_version_string(): string;
  randombytes_buf(n: number): Bytes;
  memcmp(a: Bytes, b: Bytes): boolean;
  crypto_hash_sha256(m: Bytes): Bytes;
  /** SHA-256 part by part: the state goes in and comes back (an upload's original, src/upload.ts) */
  sha256_init(): Bytes;
  sha256_update(state: Bytes, m: Bytes): Bytes;
  sha256_final(state: Bytes): Bytes;
  crypto_generichash(outLen: number, m: Bytes, key: Bytes | null): Bytes;
  crypto_pwhash(outLen: number, password: Bytes, salt: Bytes, ops: number, mem: number, alg: number): Bytes;
  crypto_kdf_derive_from_key(outLen: number, id: number, ctx: string, key: Bytes): Bytes;
  crypto_box_seal(m: Bytes, pk: Bytes): Bytes;
  crypto_box_seal_open(c: Bytes, pk: Bytes, sk: Bytes): Bytes;
  crypto_scalarmult_base(n: Bytes): Bytes;
  crypto_box_keypair(): { publicKey: Bytes; privateKey: Bytes };
  aead_encrypt(m: Bytes, ad: Bytes | null, nonce: Bytes, key: Bytes): Bytes;
  aead_decrypt(c: Bytes, ad: Bytes | null, nonce: Bytes, key: Bytes): Bytes;
  ss_init_push(key: Bytes): { state: Bytes; header: Bytes };
  ss_push(state: Bytes, m: Bytes, ad: Bytes | null, tag: number): { state: Bytes; c: Bytes };
  ss_init_pull(header: Bytes, key: Bytes): Bytes;
  ss_pull(state: Bytes, c: Bytes, ad: Bytes | null): { state: Bytes; message: Bytes; tag: number } | null;
  pad(buf: Bytes, block: number): Bytes;
  unpad(buf: Bytes, block: number): Bytes;

  // shared files and the photo library
  stat(uri: string): Promise<{ name: string; size: number; mime: string | null; deletable: boolean }>;
  readRange(uri: string, offset: number, length: number): Promise<Bytes>;
  mediaInfo(uri: string, isVideo: boolean): Promise<{ captureTs?: number; width?: number; height?: number; duration?: number; make?: string; model?: string; lat?: number; lon?: number }>;
  jpeg(uri: string, isVideo: boolean, maxPx: number, quality: number): Promise<{ bytes: Bytes; width: number; height: number } | null>;
  haptic(): void;
  /** The status and navigation bars hidden (a swipe from the edge shows them for a moment) or shown again. */
  systemBars(hidden: boolean): void;
  elapsedRealtime(): number;
  base64(b: Bytes): string;

  // automatic backup, see android/.../BackupNative.kt
  backupState(): BackupState;
  mediaFolders(): Promise<{ id: string; name: string; path: string; count: number; newest: number }[]>;
  folderMedia(bucket: string, afterId: number, limit: number): Promise<{ id: number; uri: string; name: string; size: number; mime: string }[]>;
  countFolderAfter(bucket: string, afterId: number): Promise<number>;
  askBatteryExemption(): void;
  openAppSettings(): void;
  backupNotify(title: string, text: string, progress: number, ongoing: boolean): void;
  backupNotifyCancel(): void;
  // account notices as notifications (Notices.kt, src/noticeCheck.ts)
  /** Android allows them: the app's notifications and the Security channel are on */
  noticesAllowed(): boolean;
  /** Shows a notice's notification (the lock screen shows only publicTitle); false when Android doesn't allow it. */
  noticeShow(id: number, title: string, text: string, publicTitle: string): boolean;
  noticeCancel(id: number): void;
  noticeCancelAll(): void;
  /** Keeps the app running while uploads go on (a foreground service with the notification); false if Android
   *  doesn't allow it right now. Each keepRunning(holder) needs its letGo(holder). */
  keepRunning(holder: string, title: string, text: string): boolean;
  letGo(holder: string): void;
  /** Android ended the service before letGo (its time limit). */
  keepRunningLost(): boolean;
  /** Runs the background task seconds after a new photo or video appears (NewMedia.kt), or stops watching. */
  watchNewMedia(on: boolean): void;
  /** Runs the background task once more in a few minutes (after the server couldn't be reached). */
  retryBackupSoon(minutes: number): void;
  /** The installed app's version (versionName) and build number (versionCode). */
  appVersion(): { name: string; code: number };
  /** Forgets the session cookie (sign-out). */
  clearCookies(): void;

  // passkeys (Passkeys.kt): Credential Manager, Android 14 and newer; JSON in (the server's options), JSON out
  passkeysSupported(): boolean;
  passkeyCreate(optionsJson: string): Promise<string>;
  passkeyGet(optionsJson: string): Promise<string>;
  /** A secret the person copies on purpose (setup key, recovery codes): marked sensitive, cleared after a minute. */
  copySecret(label: string, text: string): void;

  // search on the phone, see android/.../Vision.kt, SearchIndex.kt, Models.kt
  downloadModel(url: string, path: string, sha256: string, size: number): Promise<boolean>;
  checkModel(path: string, sha256: string): Promise<boolean>;
  /** clip: "mobileclip-s2" or "laion-b32" (explicit search, docs/SEARCH.md) */
  /** indexes = false: only the text model (a phone that only searches); also: a second image model to run on every
   *  photo (MobileCLIP next to LAION on the phone that indexes, docs/SEARCH.md "Explicit search"), or null */
  visionOpen(dir: string, faces: boolean, clip: string, indexes: boolean, also: string | null): Promise<void>;
  visionClose(): void;
  /** what visionOpen has open (dir is the model folder's path) */
  visionState(): { clip: string | null; dir: string | null; text: boolean; image: boolean; faces: boolean; also: string | null };
  /** clips: the open image models to run (the main one, the second one, or both) */
  visionAnalyze(jpeg: Bytes, faces: boolean, clips: string[]): Promise<Analysis>;
  visionText(ids: number[]): Promise<Bytes>;
  faceCrop(jpeg: Bytes, box: number[], px: number): Promise<Bytes | null>;
  indexPut(item: string, clip: Bytes | null, boxes: number[][], scores: number[], embs: Bytes): Promise<void>;
  indexRemove(item: string): void;
  indexHas(item: string): boolean;
  indexCount(): { items: number; faces: number };
  indexClear(): void;
  /** Writes the index to path, encrypted under key (32 bytes, derived from the master key) and bound to ad; extra goes
   *  inside. Keeps nothing of the key. */
  indexSave(path: string, key: Bytes, ad: Bytes, extra: string): Promise<void>;
  /** Replaces the index with that copy and returns its extra; null (index unchanged) if none or it doesn't open. */
  indexLoad(path: string, key: Bytes, ad: Bytes, faces: boolean): Promise<string | null>;
  indexSearch(query: Bytes, limit: number, minScore: number): Promise<Hit[]>;
  indexSimilar(item: string, limit: number, minScore: number): Promise<Hit[]>;
  indexFacesOf(item: string): { key: string; box: number[]; score: number }[];
  /** for each item, whether it has an image vector */
  indexHasAll(items: string[]): Promise<boolean[]>;
  /** the cosine of the image vectors of a[k] and b[k]; -2 where either has none */
  indexScores(a: string[], b: string[]): Promise<number[]>;
  indexCluster(threshold: number, anchors: Record<string, string[]>, rejects: Record<string, string[]>, minFaces: number): Promise<FaceGroup[]>;
  phoneMedia(): Promise<PhoneMedia[]>;

  // videos: the player decrypts in memory, see android/.../VideoVault.kt
  videoSource(server: string, id: string, key: Bytes, size: number, count: number): void;
  forgetVideos(): void;
  // thumbnails: fetched, decrypted and shown natively, see android/.../Thumbs.kt; JS names only the item
  thumbsSetup(server: string, csrf: string, dir: string | null): void;
  /** the item keys, 32 bytes each in the order of `ids` (zeroed by the caller after) */
  thumbKeys(ids: string[], keys: Bytes): void;
  thumbsPrefetch(ids: string[]): void;
  /** These items have new thumbnails (an edit): the bitmaps and cached copies go, the views load the new ones. Optional:
   *  an app with an older native module simply shows the old ones until the next lock. */
  thumbsForget?(ids: string[]): void;
  thumbsClearImages(): void;
  forgetThumbs(): void;
  /** an https page in the browser, never an app that claims the address; false when nothing could open it */
  openInBrowser(url: string): boolean;
  pickMedia(): Promise<string[]>;
  // whether what the app reads of photos keeps where they were taken (ACCESS_MEDIA_LOCATION, always before Android 10)
  mediaLocationAllowed(): boolean;
  /** only files in the outbox (cache/cf-out, outbox.ts) */
  shareFiles(paths: string[], mimes: string[]): Promise<boolean>;
  /** takes back the read access the last share gave */
  revokeShared(): void;
  /** removes the outbox's copies once they are past the grace period, even if the app isn't running then */
  outboxSweepLater(): void;
  saveToLibrary(path: string, name: string, mime: string): Promise<string>;
  /** country names in a language ("CH" → "Schweiz" for "de"), from Android's own translations */
  countryNames(codes: string[], lang: string): Record<string, string>;
  /** The language the app shows now (BCP 47): the per-app language from Android 13, else the phone's. It changes
   *  while the app runs: the activity handles locale changes itself (plugins/withConfigChanges.js). */
  appLocale?(): string | null;
  trashFromLibrary(uris: string[]): Promise<boolean>;
}

export default requireNativeModule<CfNativeModule>("CfNative");

/** Android's video player, reading the item registered with videoSource(); `controlsInset` is [top, bottom] in dp.
 *  `controls`: the viewer's bars are shown, so the player's controls are too; `onControls` when a tap shows or hides
 *  them (or they hide on their own while it plays); `onBuffering` while it waits for the video. */
export const VideoView = requireNativeView<ViewProps & {
  item: string | null; controlsInset?: [number, number]; controls?: boolean;
  onControls?: (e: { nativeEvent: { visible: boolean } }) => void;
  onBuffering?: (e: { nativeEvent: { buffering: boolean } }) => void;
}>("CfNative");

/** One item's thumbnail, decrypted natively (Thumbs.kt); `onFailed` when there is none or it can't be verified. */
export const ThumbView = requireNativeView<ViewProps & { item: string; fit?: "cover" | "contain"; software?: boolean; onFailed?: () => void; onShown?: () => void }>("CfNative", "CfThumbView");
