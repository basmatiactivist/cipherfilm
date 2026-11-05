// JitPack (the generated build.gradle adds it for every project, and a library adds it again before Maven Central for
// itself) may serve only com.github.* packages: an androidx, React Native or other Maven Central artifact can never
// come from there, even if a version were missing from Central.
const { withProjectBuildGradle } = require("expo/config-plugins");

const JITPACK = `
// JitPack only for com.github.* (plugins/withGradleSources.js), also where a library adds it itself
allprojects {
  repositories.withType(MavenArtifactRepository).configureEach { repo ->
    if (repo.url.host in ["jitpack.io", "www.jitpack.io"]) repo.content { includeGroupByRegex "com\\\\.github\\\\..*" }
  }
}
`;

module.exports = function withGradleSources(config) {
  return withProjectBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("withGradleSources")) c.modResults.contents += JITPACK;
    return c;
  });
};
