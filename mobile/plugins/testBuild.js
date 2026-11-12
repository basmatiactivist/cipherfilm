// Whether this build is a test build for the emulator or a test phone: only when CF_TEST_CA names the local test
// instance's CA explicitly. A missing signing key does not make a test build: the release workflow builds unsigned
// (CF_UNSIGNED) and signs elsewhere, and its APK and Play bundle must behave like a signed release.
module.exports = function isTestBuild(env) {
  return !!env.CF_TEST_CA && !env.CF_KEYSTORE && !env.CF_UNSIGNED && env.CF_STORE !== "play";
};
