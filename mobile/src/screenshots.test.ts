import { beforeEach, describe, expect, it, vi } from "vitest";

// Allowing screenshots: the setting lives natively (ScreenGuard.kt, read before the first frame); the store shows it,
// changes it at once through the native module and puts it back to blocked at sign-out. Native module is a stand-in.
const t = vi.hoisted(() => ({ stored: false as boolean | "throw", calls: [] as boolean[], signOut: [] as (() => void)[], failSet: false }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    screenshotsAllowed: () => { if (t.stored === "throw") throw new Error("no module"); return t.stored; },
    allowScreenshots: (on: boolean) => { if (t.failSet) throw new Error("no activity"); t.calls.push(on); t.stored = on; },
  },
}));
vi.mock("./session", () => ({ onSignOut: (f: () => void) => { t.signOut.push(f); } }));
vi.mock("react", () => ({ useSyncExternalStore: (_: unknown, get: () => unknown) => get() }));

async function load(stored: boolean | "throw") {
  vi.resetModules();
  Object.assign(t, { stored, calls: [], signOut: [], failSet: false });
  return import("./screenshots");
}

describe("allow screenshots", () => {
  beforeEach(() => { vi.resetModules(); });

  it("is off by default: blocked, as before the setting existed", async () => {
    const m = await load(false);
    expect(m.useScreenshots()).toBe(false);
    expect(t.calls).toEqual([]); // loading changes nothing on the window
  });

  it("stays off when the native module can't say", async () => {
    const m = await load("throw");
    expect(m.useScreenshots()).toBe(false);
  });

  it("shows what this phone stored at an earlier launch", async () => {
    const m = await load(true);
    expect(m.useScreenshots()).toBe(true);
  });

  it("switching applies at once through the native module, both ways", async () => {
    const m = await load(false);
    m.setScreenshots(true);
    expect(t.calls).toEqual([true]);
    expect(m.useScreenshots()).toBe(true);
    m.setScreenshots(false);
    expect(t.calls).toEqual([true, false]);
    expect(m.useScreenshots()).toBe(false);
  });

  it("keeps showing the window's real state when the native call fails", async () => {
    const m = await load(false);
    t.failSet = true;
    m.setScreenshots(true);
    expect(m.useScreenshots()).toBe(false);
  });

  it("goes back to blocked at sign-out", async () => {
    const m = await load(true);
    expect(t.signOut).toHaveLength(1);
    t.signOut[0]();
    expect(t.calls).toEqual([false]);
    expect(t.stored).toBe(false);
    expect(m.useScreenshots()).toBe(false);
  });
});
