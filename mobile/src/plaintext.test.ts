import { describe, expect, it } from "vitest";

// Rules that keep decrypted photos off the phone's storage, checked in the source because they are easy to break by
// accident: a new picture that expo-image would cache on disk, or a share resolved into unencrypted copies.
// Vite reads the files in (the app's tsconfig has no Node types)
declare global { interface ImportMeta { glob(pattern: string[], o: { query: "?raw"; import: "default"; eager: true }): Record<string, string> } }
const files = Object.entries(import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.ts"], { query: "?raw", import: "default", eager: true })).map(([p, text]) => ({ p, text }));
const appJson = Object.values(import.meta.glob(["../app.json"], { query: "?raw", import: "default", eager: true }))[0];

describe("decrypted pictures stay off the disk", () => {
  it("every expo-image picture is cached in memory only (its default is a disk cache)", () => {
    const tags = files.flatMap(({ p, text }) => /from "expo-image"/.test(text) ? [...text.matchAll(/<Image\b[\s\S]*?\/>/g)].map((m) => ({ p, tag: m[0] })) : []);
    expect(files.length).toBeGreaterThan(20);
    expect(tags.length).toBeGreaterThan(0);
    for (const { p, tag } of tags) expect(tag, p).toMatch(/cachePolicy="(memory|none)"/);
  });

  it("no prefetch into expo-image's disk cache", () => {
    for (const { p, text } of files) expect(text, p).not.toMatch(/Image\.prefetch\(/);
  });

  it("shares into the app are read from their content:// links, never copied (expo-sharing's resolved payloads are copies)", () => {
    for (const { p, text } of files) expect(text, p).not.toMatch(/getResolvedSharedPayloads/);
  });

  it("nothing decrypted is put on the clipboard", () => {
    for (const { p, text } of files) expect(text, p).not.toMatch(/Clipboard|expo-clipboard/);
  });

  // The one exception, on purpose and on a tap: the authenticator key while two-step sign-in is set up and the
  // recovery codes shown once, which belong in a password manager. Neither is library content. CfNative.copySecret
  // (Passkeys.kt) marks them sensitive (not in Android 13's copy preview) and clears them after a minute.
  it("only the two-step sign-in screen copies, and only its secrets", () => {
    const users = files.filter(({ text }) => /\bcopySecret\(/.test(text)).map(({ p }) => p);
    expect(users).toEqual(["./app/two-step.tsx"]);
    const calls = [...files.find(({ p }) => p === "./app/two-step.tsx")!.text.matchAll(/copySecret\(t\("([^"]+)"\), ([\w.]+)\)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(calls).toEqual(["Authenticator key: setup.secret", "Recovery codes: all"]);
  });

  it("clears exactly its own copy after a minute, with nothing left registered that could keep it there", async () => {
    // @ts-ignore: runs in Node (vitest), where the app's types have no node:fs
    const { readFileSync } = await import("node:fs");
    const kt: string = readFileSync(new URL("../modules/cf-native/android/src/main/java/app/cipherfilm/cfnative/Passkeys.kt", import.meta.url), "utf8");
    const clip = kt.slice(kt.indexOf("internal object SecretClip"));
    // whether something was copied since is told by the clip's own random mark, not by a change listener
    expect(clip).not.toMatch(/PrimaryClipChangedListener/);
    expect(clip).toContain("putString(MARK, mark)");
    expect(clip).toContain("d.extras?.getString(MARK) == mark");
    expect(clip).toContain("main.postDelayed(r, CLEAR_AFTER_MS)");
  });
});

describe("Android backup", () => {
  it("is off for the app's data", () => {
    const app = JSON.parse(appJson);
    expect(app.expo.android.allowBackup).toBe(false);
  });
});

describe("the phone's location", () => {
  it("is never asked for: the map library's location permissions are left out of the app", () => {
    const app = JSON.parse(appJson);
    expect(app.expo.android.blockedPermissions).toEqual(expect.arrayContaining(["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]));
  });
});
