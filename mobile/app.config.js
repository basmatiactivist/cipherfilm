// app.json plus what a release build sets: the version from the tag (CF_VERSION), the signing plugin, and which store
// the build is for (CF_STORE=play for Google Play; anything else is the APK on GitHub releases, for Obtainium).
const BATTERY = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";

module.exports = ({ config }) => {
  const v = process.env.CF_VERSION;
  if (v) {
    const [major, minor, patch] = v.split(/[.-]/).map(Number);
    config.version = v;
    config.android = { ...config.android, versionCode: major * 1_000_000 + minor * 1_000 + patch };
  }
  // the Play build (docs/play/REQUIREMENTS.md): no direct battery-exemption request (BackupNative.askBatteryExemption
  // opens Android's list instead, seeing the permission isn't declared) and no explicit search model (src/store.ts)
  const store = process.env.CF_STORE === "play" ? "play" : "github";
  if (process.env.CF_STORE && process.env.CF_STORE !== "play" && process.env.CF_STORE !== "github") throw new Error(`CF_STORE must be play or github, not ${process.env.CF_STORE}`);
  config.extra = { ...config.extra, store };
  if (store === "play") {
    config.android = {
      ...config.android,
      permissions: (config.android?.permissions ?? []).filter((p) => p !== BATTERY),
      blockedPermissions: [...new Set([...(config.android?.blockedPermissions ?? []), BATTERY])], // also if a library adds it
    };
  }
  config.plugins = [...(config.plugins ?? []), "./plugins/withReleaseSigning", "./plugins/withConfigChanges", "./plugins/withGradleSources", "./plugins/withStoragePermission", "./plugins/withLocales"];
  // a test build for the emulator may trust the local test instance (mobile/dev); a signed release never does
  if (process.env.CF_TEST_CA && !process.env.CF_KEYSTORE) {
    config.plugins.push(["./plugins/withTestCA", { ca: process.env.CF_TEST_CA }]);
    // on a real phone (adb reverse tcp:8443 tcp:8443, server https://localhost:8443): its own id and name, so it sits
    // next to an installed release instead of clashing with its signature
    if (process.env.CF_TEST_PACKAGE) {
      config.android = { ...config.android, package: "app.cipherfilm.test" };
      config.name = "Cipherfilm Test";
    }
  }
  return config;
};
