// @ts-nocheck: runs in Node (vitest), where the app's types have no node:fs
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The long native jobs must not run on the one thread Expo gives every module's AsyncFunctions (fetch, files, secure
// store go through it): there they held up every request of the app, and screens that load something stayed empty.
describe("the native module", () => {
  const dir = path.resolve(import.meta.dirname, "../../modules/cf-native/android/src/main/java/app/cipherfilm/cfnative");
  const mod = readFileSync(path.join(dir, "CfNativeModule.kt"), "utf8");
  it.each(["downloadModel", "checkModel", "visionOpen", "visionAnalyze", "visionText", "faceCrop", "indexPut", "indexSave", "indexLoad", "indexSearch", "indexSimilar", "indexCluster"])(
    "%s runs on a thread of its own", (name) => {
      const at = mod.indexOf(`AsyncFunction("${name}")`);
      expect(at).toBeGreaterThan(0);
      const next = /\n {4}(Async)?Function\(|\n {4}\/\/ /g;
      next.lastIndex = at + 1;
      const def = mod.slice(at, next.exec(mod)?.index); // up to the next definition
      expect(def).toMatch(new RegExp(`^AsyncFunction\\("${name}"\\) Coroutine \\{[^]*?withContext\\((Lanes\\.\\w+|Dispatchers\\.Default)\\)`));
    });
  it("says what is open without waiting for the models to open", () => {
    const vision = readFileSync(path.join(dir, "Vision.kt"), "utf8");
    expect(vision).not.toMatch(/@Synchronized fun state\(/);
    expect(mod).toMatch(/Function\("visionClose"\) \{ Lanes\.visionExecutor\.execute/);
  });
});
