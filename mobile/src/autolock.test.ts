import { beforeEach, describe, expect, it, vi } from "vitest";

// The automatic lock: away too long (by the native timer or on coming back), or the screen off if chosen, locks;
// a running upload from the app delays it until the uploads are over. Android's screens the app opens itself (marked
// with away or expectAway) don't count as leaving. Native module, session and uploads are stand-ins.
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
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: (_: string, f: (s: string) => void) => { t.appState.push(f); return { remove() {} }; } } }));
vi.mock("expo-file-system", () => ({
  File: class { get exists() { return t.file !== ""; } textSync() { return t.file; } async write(s: string) { t.file = s; } delete() { t.file = ""; } },
  Paths: { document: "/doc" },
}));
vi.mock("./session", () => ({
  session: () => ({ phase: t.phase }),
  lock: (byHand = false) => { t.locks.push(byHand); t.phase = "locked"; },
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

  it("arms the native timer in the background and locks when it fires; not by hand, so the fingerprint is asked at once", async () => {
    await started();
    app("background");
    expect(t.timer).toBe(5 * 60 * 1000);
    fire();
    expect(t.locks).toEqual([false]);
  });

  it("locks on coming back after longer than the chosen time, also when the timer missed it", async () => {
    await started();
    app("background");
    t.now += 5 * 60 * 1000 + 1;
    app("active");
    expect(t.timer).toBe(-1);
    expect(t.locks).toEqual([false]);
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
    expect(t.locks).toEqual([false]);
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
    expect(t.locks).toEqual([false]);
  });

  it("does not lock again between two files when nothing was due", async () => {
    await started();
    t.idle.forEach((f) => f());
    expect(t.timer).toBe(-1);
  });

  it("'Immediately' locks at every leave, even a short one", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    app("background");
    expect(t.timer).toBe(0);
    fire();
    expect(t.locks).toEqual([false]);
  });

  it("'Immediately' also locks on coming back when the timer didn't get to fire", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    app("background");
    t.now += 300;
    app("active");
    expect(t.locks).toEqual([false]);
  });

  it("a screen the app opened (picker, permission, share sheet) is no leave, up to 10 minutes", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    let answer!: (v: string[]) => void;
    const picked = m.away(() => new Promise<string[]>((r) => { answer = r; }));
    app("background");
    expect(t.timer).toBe(10 * 60 * 1000);
    t.now += 3 * 60 * 1000;
    app("active");
    answer(["content://1"]);
    expect(await picked).toEqual(["content://1"]);
    expect(t.locks).toEqual([]);
    // the next leave is a real one again
    app("background");
    expect(t.timer).toBe(0);
    fire();
    expect(t.locks).toEqual([false]);
  });

  it("a screen the app opened still locks when the trip lasts longer than 10 minutes", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    void m.away(() => new Promise(() => {}));
    app("background");
    t.now += 10 * 60 * 1000 + 1;
    app("active");
    expect(t.locks).toEqual([false]);
  });

  it("a prompt that answered without the app leaving (the fingerprint) leaves no mark behind", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    await m.away(async () => true);
    app("background");
    expect(t.timer).toBe(0);
  });

  it("expectAway (settings, the battery list) counts only for a leave right after it", async () => {
    const m = await started();
    m.setAutoLock({ after: 0 });
    m.expectAway();
    t.now += 500;
    app("background");
    expect(t.timer).toBe(10 * 60 * 1000);
    t.now += 60 * 1000;
    app("active");
    expect(t.locks).toEqual([]);
    // used up; and one that is never followed by a leave lapses
    m.expectAway();
    t.now += 6000;
    app("background");
    expect(t.timer).toBe(0);
  });

  it("the app's own screens get the chosen time when that is longer", async () => {
    const m = await started();
    m.setAutoLock({ after: 15 * 60 * 1000 });
    m.expectAway();
    app("background");
    expect(t.timer).toBe(15 * 60 * 1000);
  });

  it("locks at screen off only when chosen, and keeps the choice", async () => {
    const m = await started();
    fire("screen");
    expect(t.locks).toEqual([]);
    m.setAutoLock({ screenOff: true });
    expect(t.screen).toBe(true);
    fire("screen");
    expect(t.locks).toEqual([false]);
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
