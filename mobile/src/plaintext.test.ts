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
});

describe("Android backup", () => {
  it("is off for the app's data", () => {
    const app = JSON.parse(appJson);
    expect(app.expo.android.allowBackup).toBe(false);
  });
});
