// Android recreates the activity when the font size, display size or language changes, unless the manifest says the
// app handles it. Recreating mounts a second React root before the old one is gone, and expo-router then unbinds its
// imperative router when the old one unmounts: every router.push/replace afterwards throws and closes the app. React
// Native handles these changes itself (new metrics and font scale), so the activity stays.
const { withAndroidManifest } = require("expo/config-plugins");

const MORE = ["fontScale", "density", "locale", "layoutDirection"];

module.exports = function withConfigChanges(config) {
  return withAndroidManifest(config, (c) => {
    const main = c.modResults.manifest.application[0].activity.find((a) => a.$["android:name"] === ".MainActivity");
    if (!main) throw new Error("withConfigChanges: no MainActivity in the manifest");
    const have = (main.$["android:configChanges"] ?? "").split("|").filter(Boolean);
    main.$["android:configChanges"] = [...have, ...MORE.filter((x) => !have.includes(x))].join("|");
    return c;
  });
};
