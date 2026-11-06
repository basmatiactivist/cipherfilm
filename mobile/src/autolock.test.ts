import { beforeEach, describe, expect, it, vi } from "vitest";

// The automatic lock: away too long (by the native timer or on coming back), or the screen off if chosen, locks;
// a running upload from the app delays it until the uploads are over. Native module, session and uploads are stand-ins.
const t = vi.hoisted(() => ({
  now: 0, phase: "unlocked", uploads: 0, locks: [] as boolean[], timer: -1, screen: false,
  listeners: {} as Record<string, (e: { why: string }) => void>,
  appState: [] as ((s: string) => void)[], idle: [] as (() => void)[], file: "",
}));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: {
    elapsedRealtime: () => t.now,
    lockAfter: (ms: number) => { t.timer = ms; },
    lockCancel: () => { t.timer = -1; },
    watchScreen: (on: boolean) => { t.screen = on; },
    addListener: (name: string, f: (e: { why: string }) => void) => { t.listeners[name] = f; },
  },
}));
vi.mock("react-native", () => ({ AppState: { addEventListener: (_: string, f: (s: string) => void) => { t.appState.push(f); return { remove() {} }; } } }));
vi.mock("expo-file-system", () => ({
  File: class { get exists() { return t.file !== ""; } textSync() { return t.file; } async write(s: string) { t.file = s; } delete() { t.file = ""; } },
  Paths: { document: "/doc" },
}));
vi.mock("./session", () => ({
  session: () => ({ phase: t.phase }),
  lock: (shown: boolean) => { t.locks.push(shown); t.phase = "locked"; },
  onSignOut: () => {},
}));
vi.mock("./upload", () => ({ uploadsRunning: () => t.uploads, onUploadsIdle: (f: () => void) => { t.idle.push(f); return () => {}; } }));

const app = (s: string) => t.appState.forEach((f) => f(s));
const fire = (why = "timer") => t.listeners.onLockDue({ why });

async function started(file = "") {
  vi.resetModules();
  Object.assign(t, { now: 1_000_000, phase: "unlocked", uploads: 0, locks: [], timer: -1, screen: false, listeners: {}, appState: [], idle: [], file });
  const m = await import("./autolock");
  m.startAutoLock();
  return m;
}

describe("automatic lock", () => {
  beforeEach(() => { vi.resetModules(); });

  it("arms the native timer in the background and locks when it fires, shown as locked", async () => {
    await started();
    app("background");
    expect(t.timer).toBe(5 * 60 * 1000);
    fire();
    expect(t.locks).toEqual([true]);
  });

  it("locks on coming back after longer than the chosen time, also when the timer missed it", async () => {
    await started();
    app("background");
    t.now += 5 * 60 * 1000 + 1;
    app("active");
    expect(t.timer).toBe(-1);
    expect(t.locks).toEqual([true]);
  });

  it("stays unlocked after a short time away", async () => {
    await started();
    app("background");
    t.now += 60 * 1000;
    app("active");
    expect(t.locks).toEqual([]);
  });

  it("locks when the clock went backwards (can't trust the time away)", async () => {
    await started();
    app("background");
    t.now -= 10;
    app("active");
    expect(t.locks).toEqual([true]);
  });

  it("waits for running uploads, then locks through the native timer after the last one", async () => {
    await started();
    app("background");
    t.uploads = 1;
    fire();
    expect(t.locks).toEqual([]);
    t.uploads = 0;
    t.idle.forEach((f) => f());
    expect(t.timer).toBe(2000);
    fire();
    expect(t.locks).toEqual([true]);
  });

  it("does not lock again between two files when nothing was due", async () => {
    await started();
    t.idle.forEach((f) => f());
    expect(t.timer).toBe(-1);
  });

  it("'Immediately' still gives Android's own screens a few seconds", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    app("background");
    expect(t.timer).toBe(10 * 1000);
    t.now += 3000;
    app("active");
    expect(t.locks).toEqual([]);
  });

  it("locks at screen off only when chosen, and keeps the choice", async () => {
    const m = await started();
    fire("screen");
    expect(t.locks).toEqual([]);
    m.setAutoLock({ screenOff: true });
    expect(t.screen).toBe(true);
    fire("screen");
    expect(t.locks).toEqual([true]);
    const again = await started(t.file);
    expect(again.useAutoLock).toBeDefined();
    expect(t.screen).toBe(true);
  });

  it("ignores a stored time that isn't one of the choices", async () => {
    await started(JSON.stringify({ after: 1, screenOff: false }));
    app("background");
    expect(t.timer).toBe(5 * 60 * 1000);
  });

  it("does nothing while locked or signed out", async () => {
    await started();
    t.phase = "locked";
    fire();
    expect(t.locks).toEqual([]);
  });
});
