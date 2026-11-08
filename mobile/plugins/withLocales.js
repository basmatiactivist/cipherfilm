// The languages the app speaks (src/i18n.ts), declared to Android: from Android 13 they appear under Settings ›
// Apps › Cipherfilm › Language, so the app can be German on an English phone and the other way round.
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const LOCALES = ["en", "de"];

module.exports = function withLocales(config) {
  config = withDangerousMod(config, ["android", async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, "app/src/main/res/xml");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "locales_config.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n${LOCALES.map((l) => `  <locale android:name="${l}"/>`).join("\n")}\n</locale-config>\n`);
    return c;
  }]);
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest.application[0].$["android:localeConfig"] = "@xml/locales_config";
    return c;
  });
};
