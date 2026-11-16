import { describe, expect, it, vi } from "vitest";

// The locked folder closes when the app goes to the background; a viewer opened from it leaves with it.
const app = vi.hoisted(() => ({ change: [] as ((s: string) => void)[] }));
vi.mock("react-native", () => ({ AppState: { addEventListener: (_: string, f: (s: string) => void) => { app.change.push(f); return { remove() {} }; } } }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: { forgetVideos: () => {} } }));
vi.mock("./library", () => ({ thumbBytes: async () => new Uint8Array(0) }));
vi.mock("./libraryStore", () => ({ lockedItems: () => [{ id: "a" }, { id: "b" }], onLockedChange: () => () => {}, refreshLibrary: async () => {} }));
vi.mock("./session", () => ({ onWipe: () => {}, passwordProof: async () => {}, session: () => ({ masterKey: new Uint8Array(32) }) }));
vi.mock("./autolock", () => ({ away: (f: () => unknown) => f() }));
vi.mock("./api", () => ({ api: async () => ({}) }));

const f = await import("./lockedFolder");

describe("a viewer opened from the locked folder", () => {
  it("must leave once the app went to the background, never another viewer", () => {
    f.openLockedFolder();
    expect(f.lockedFolderOpen()).toBe(true);
    expect(f.mustLeaveFolder("locked", f.lockedFolderOpen())).toBe(false);
    for (const g of app.change) g("background");
    expect(f.lockedFolderOpen()).toBe(false);
    expect(f.lockedFolderItems()).toEqual([]);
    expect(f.mustLeaveFolder("locked", f.lockedFolderOpen())).toBe(true);
    expect(f.mustLeaveFolder(undefined, false)).toBe(false);
    expect(f.mustLeaveFolder("search", false)).toBe(false);
  });
});
