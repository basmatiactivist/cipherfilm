// The photo library up to Android 12 (minSdk is 24): READ_EXTERNAL_STORAGE, only up to API 32. From Android 13 the
// app uses READ_MEDIA_IMAGES/VIDEO (app.json), and Google Play's photo policy is about those; this one with
// maxSdkVersion 32 needs no declaration of its own. app.json can't give a permission attributes, so this plugin does.
// tools:replace makes the app's maxSdkVersion win over a library that asks for the permission without one.
const { withAndroidManifest } = require("expo/config-plugins");

const NAME = "android.permission.READ_EXTERNAL_STORAGE";

module.exports = function withStoragePermission(config) {
  return withAndroidManifest(config, (c) => {
    const m = c.modResults.manifest;
    m.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
    const list = (m["uses-permission"] ??= []);
    const kept = list.filter((p) => p.$["android:name"] !== NAME);
    kept.push({ $: { "android:name": NAME, "android:maxSdkVersion": "32", "tools:replace": "android:maxSdkVersion" } });
    m["uses-permission"] = kept;
    return c;
  });
};
