// Which Android permission opens the photo library depends on the version: READ_EXTERNAL_STORAGE up to Android 12
// (declared with maxSdkVersion 32, plugins/withStoragePermission.js), READ_MEDIA_IMAGES/VIDEO from Android 13, and
// from Android 14 the person may allow only some photos (READ_MEDIA_VISUAL_USER_SELECTED, "partial" in
// BackupNative.mediaAccess). ACCESS_MEDIA_LOCATION (Android 10+) keeps the photos' location in what the app reads:
// the upload puts it into the encrypted details (upload.ts), so it is asked for where the backup is set up.
import { PermissionsAndroid, type Permission } from "react-native";
import N from "../modules/cf-native/src/CfNativeModule";

const IMAGES = "android.permission.READ_MEDIA_IMAGES" as Permission;
const VIDEO = "android.permission.READ_MEDIA_VIDEO" as Permission;
const SELECTED = "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" as Permission;
const STORAGE = "android.permission.READ_EXTERNAL_STORAGE" as Permission;
const LOCATION = "android.permission.ACCESS_MEDIA_LOCATION" as Permission;

/** The permissions to ask for on this Android version (sdk = Build.VERSION.SDK_INT). */
export function mediaPermissions(sdk: number, location: boolean): Permission[] {
  const out = sdk >= 33 ? [IMAGES, VIDEO] : [STORAGE];
  if (sdk >= 34) out.push(SELECTED);
  if (location && sdk >= 29) out.push(LOCATION);
  return out;
}

/** Asks Android for access to photos and videos (after the disclosure, disclosure.tsx). When Android won't ask any
 *  more and nothing is allowed, its app settings open instead. Returns what is allowed now. */
export async function requestMediaAccess(location: boolean): Promise<"full" | "partial" | "none"> {
  const r = await PermissionsAndroid.requestMultiple(mediaPermissions(N.backupState().sdk, location));
  const now = N.backupState().media;
  if (now === "none" && Object.values(r).includes(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) N.openAppSettings();
  return now;
}
