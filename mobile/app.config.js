// app.json plus what a release build sets: the version from the tag (CF_VERSION), the signing plugin, and which store
// the build is for (CF_STORE=play for Google Play; anything else is the APK on GitHub releases, for Obtainium).
const isTestBuild = require("./plugins/testBuild");
const BATTERY = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";

module.exports = ({ config }) => {
  const v = process.env.CF_VERSION;
  if (v) {
    const [major, minor, patch] = v.split(/[.-]/).map(Number);
    config.version = v;
    config.android = { ...config.android, versionCode: major * 1_000_000 + minor * 1_000 + patch };
  }
  // the Play build (docs/play/REQUIREMENTS.md): no direct battery-exemption request (BackupNative.askBatteryExemption
  // opens Android's list instead, seeing the permission isn't declared) and always filters explicit content from search (src/store.ts)
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
  // a test build for the emulator may trust the local test instance (mobile/dev) and allow e2e screenshots; a release
  // (signed here, or built unsigned by the release workflow) never does
  if (isTestBuild(process.env)) {
    config.plugins.push(["./plugins/withTestCA", { ca: process.env.CF_TEST_CA }]);
  }
  // a build to try on a real phone next to the installed release (a test build, or a store build tried against a
  // server with a real certificate, e.g. on a tailnet): its own id, name and address, so it doesn't clash with the
  // release's signature and the passkey page's answer comes back to it. Never for a signed or a release build.
  if (process.env.CF_TEST_PACKAGE && !process.env.CF_KEYSTORE && !process.env.CF_UNSIGNED) {
    config.android = { ...config.android, package: "app.cipherfilm.test" };
    config.name = store === "play" ? "Cipherfilm Play" : "Cipherfilm Test";
    config.scheme = "cipherfilm-test";
  }
  return config;
};
