// @ts-nocheck: runs in Node (vitest), where the app's types have no node:fs
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const isTestBuild = require("../plugins/testBuild") as (env: Record<string, string | undefined>) => boolean;
const appConfig = require("../app.config") as (a: { config: Record<string, unknown> }) => { plugins: unknown[] };

function withEnv<T>(env: Record<string, string | undefined>, f: () => T): T {
  const keys = ["CF_TEST_CA", "CF_KEYSTORE", "CF_UNSIGNED", "CF_STORE", "CF_TEST_PACKAGE"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return f(); } finally { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const hasTestCA = (plugins: unknown[]) => plugins.some((p) => Array.isArray(p) && p[0] === "./plugins/withTestCA");

describe("test build flag", () => {
  it("is only set by an explicit test CA, never by a missing signing key", () => {
    expect(isTestBuild({})).toBe(false); // the release workflow's unsigned build without CF_KEYSTORE
    expect(isTestBuild({ CF_UNSIGNED: "1" })).toBe(false);
    expect(isTestBuild({ CF_TEST_CA: "/ca.pem" })).toBe(true);
    expect(isTestBuild({ CF_TEST_CA: "/ca.pem", CF_KEYSTORE: "/k" })).toBe(false);
    expect(isTestBuild({ CF_TEST_CA: "/ca.pem", CF_UNSIGNED: "1" })).toBe(false);
    expect(isTestBuild({ CF_TEST_CA: "/ca.pem", CF_STORE: "play" })).toBe(false);
  });

  it("app.config adds the test plugin only for a test build", () => {
    expect(hasTestCA(withEnv({ CF_UNSIGNED: "1" }, () => appConfig({ config: {} }).plugins))).toBe(false);
    expect(hasTestCA(withEnv({}, () => appConfig({ config: {} }).plugins))).toBe(false);
    expect(hasTestCA(withEnv({ CF_TEST_CA: "/ca.pem" }, () => appConfig({ config: {} }).plugins))).toBe(true);
    expect(hasTestCA(withEnv({ CF_TEST_CA: "/ca.pem", CF_STORE: "play" }, () => appConfig({ config: {} }).plugins))).toBe(false);
  });

  it("the native TEST_BUILD (screenshot sysprop) follows the plugin's Gradle property, not the signing env alone", () => {
    const g = readFileSync(path.join(import.meta.dirname, "../modules/cf-native/android/build.gradle"), "utf8");
    const line = g.split("\n").find((l) => l.includes('"TEST_BUILD"'))!;
    expect(line).toContain('findProperty("cfTestBuild") == "true"');
    expect(line).toContain("CF_UNSIGNED");
    expect(readFileSync(path.join(import.meta.dirname, "../plugins/withTestCA.js"), "utf8")).toContain('key: "cfTestBuild"');
  });
});
