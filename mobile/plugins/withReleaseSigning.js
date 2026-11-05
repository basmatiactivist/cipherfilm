// Signs release builds with the key named by CF_KEYSTORE (the release workflow writes it from a secret); without it
// a release build is signed with the debug key, for local testing only.
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (g.includes("CF_KEYSTORE")) return c;
    g = g.replace(/signingConfigs \{\n(\s+)debug \{/, (m, ind) => `signingConfigs {
${ind}release {
${ind}    if (System.getenv("CF_KEYSTORE")) {
${ind}        storeFile file(System.getenv("CF_KEYSTORE"))
${ind}        storePassword System.getenv("CF_KEYSTORE_PASSWORD")
${ind}        keyAlias "cipherfilm"
${ind}        keyPassword System.getenv("CF_KEYSTORE_PASSWORD")
${ind}    }
${ind}}
${ind}debug {`);
    g = g.replace(/(release \{[^{}]*?)signingConfig signingConfigs\.debug/, '$1signingConfig System.getenv("CF_KEYSTORE") ? signingConfigs.release : signingConfigs.debug');
    if (!g.includes('System.getenv("CF_KEYSTORE") ? signingConfigs.release')) throw new Error("withReleaseSigning: build.gradle layout changed");
    c.modResults.contents = g;
    return c;
  });
};
