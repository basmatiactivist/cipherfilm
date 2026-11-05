// app.json plus what a release build sets: the version from the tag (CF_VERSION) and the signing plugin.
module.exports = ({ config }) => {
  const v = process.env.CF_VERSION;
  if (v) {
    const [major, minor, patch] = v.split(/[.-]/).map(Number);
    config.version = v;
    config.android = { ...config.android, versionCode: major * 1_000_000 + minor * 1_000 + patch };
  }
  config.plugins = [...(config.plugins ?? []), "./plugins/withReleaseSigning", "./plugins/withConfigChanges"];
  // a test build for the emulator may trust the local test instance (mobile/dev); a signed release never does
  if (process.env.CF_TEST_CA && !process.env.CF_KEYSTORE) config.plugins.push(["./plugins/withTestCA", { ca: process.env.CF_TEST_CA }]);
  return config;
};
