// Test builds only: trust the local test instance's certificate authority (mobile/dev), for https://10.0.2.2:8443 in
// the emulator and https://localhost:8443 on a phone (adb reverse tcp:8443 tcp:8443). app.config.js adds this plugin
// only for a test build (testBuild.js: CF_TEST_CA names the CA file, not a release), so a released app never trusts it.
// It also sets the Gradle property cfTestBuild, the only thing that makes the native module's TEST_BUILD true (the
// e2e screenshot switch, ScreenGuard.kt).
const fs = require("fs");
const path = require("path");
const { withAndroidManifest, withDangerousMod, withGradleProperties } = require("expo/config-plugins");

module.exports = function withTestCA(config, { ca }) {
  config = withDangerousMod(config, ["android", (c) => {
    const res = path.join(c.modRequest.platformProjectRoot, "app/src/main/res");
    fs.mkdirSync(path.join(res, "raw"), { recursive: true });
    fs.mkdirSync(path.join(res, "xml"), { recursive: true });
    fs.copyFileSync(ca, path.join(res, "raw/cf_test_ca.pem"));
    fs.writeFileSync(path.join(res, "xml/network_security_config.xml"), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">localhost</domain>
    <trust-anchors><certificates src="@raw/cf_test_ca" /></trust-anchors>
  </domain-config>
</network-security-config>
`);
    return c;
  }]);
  config = withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter((p) => !(p.type === "property" && p.key === "cfTestBuild"));
    c.modResults.push({ type: "property", key: "cfTestBuild", value: "true" });
    return c;
  });
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest.application[0].$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return c;
  });
};
