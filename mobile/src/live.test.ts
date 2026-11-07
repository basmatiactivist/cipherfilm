import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live updates on the phone: the stream's parser, reconnecting, and that it streams only on screen and unlocked.
// The server is a stand-in that writes into a ReadableStream, as expo/fetch's body is one.
const st = vi.hoisted(() => ({ appState: "active", listeners: [] as ((s: string) => void)[] }));
vi.mock("expo/fetch", () => ({ fetch: async () => { throw new Error("no network in the tests"); } }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() { return st.appState; },
    addEventListener: (_: string, f: (s: string) => void) => { st.listeners.push(f); return { remove() {} }; },
  },
}));
vi.mock("./api", () => ({ server: () => "https://photos.example" }));

import type { Opener, Topic } from "./live";

interface Conn { send: (s: string) => void; end: () => void; signal: AbortSignal }
function opener() {
  const conns: Conn[] = [];
  const open: Opener = async (signal) => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    signal.addEventListener("abort", () => { try { ctl.error(new Error("aborted")); } catch { /* closed */ } });
    conns.push({ send: (s) => ctl.enqueue(new TextEncoder().encode(s)), end: () => ctl.close(), signal });
    return { ok: true, status: 200, body };
  };
  return { conns, open, last: () => conns[conns.length - 1] };
}

describe("sseParser", () => {
  it("finds the events however the text is cut", async () => {
    const { sseParser } = await import("./live");
    const text = "retry: 3000\nevent: ready\ndata: {\"v\":1}\n\n:\n\nevent: changed\r\ndata: {\"v\":2,\r\ndata: \"what\":[\"items\"]}\r\n\r\n";
    for (const size of [1, 3, 7, text.length]) {
      const parse = sseParser();
      const got = [];
      for (let i = 0; i < text.length; i += size) got.push(...parse(text.slice(i, i + size)));
      expect(got).toEqual([
        { event: "ready", data: "{\"v\":1}" },
        { event: ":", data: "" },
        { event: "changed", data: "{\"v\":2,\n\"what\":[\"items\"]}" },
      ]);
    }
  });
});

describe("startLive", () => {
  let changes: Topic[][];
  let probe: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    changes = [];
    probe = vi.fn(async () => ({}));
  });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("passes on what changed", async () => {
    const { startLive } = await import("./live");
    const s = opener();
    stop = startLive({ onChange: (w) => changes.push(w), probe, open: s.open });
    await vi.advanceTimersByTimeAsync(0);
    s.last().send("retry: 3000\nevent: ready\ndata: {\"v\":4}\n\n");
    s.last().send("event: changed\ndata: {\"v\":5,\"what\":[\"items\",\"nonsense\"]}\n\nevent: changed\ndata: {\"v\":6,\"what\":[\"albums\"]}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([["items"], ["albums"]]);
  });

  it("after a drop: a probe, a new stream, and everything loads if the counter moved meanwhile", async () => {
    const { startLive } = await import("./live");
    const s = opener();
    const memory: { v?: number } = {};
    stop = startLive({ onChange: (w) => changes.push(w), probe, open: s.open, memory });
    await vi.advanceTimersByTimeAsync(0);
    s.last().send("event: ready\ndata: {\"v\":4}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    s.last().end(); // the server restarted
    await vi.advanceTimersByTimeAsync(1100);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(s.conns.length).toBe(2);
    s.last().send("event: ready\ndata: {\"v\":900}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([["items", "trash", "albums", "people", "index"]]);
    expect(memory.v).toBe(900);
  });

  it("a goodbye (the session ended) closes the stream and asks the server before anything else", async () => {
    const { startLive } = await import("./live");
    const s = opener();
    probe.mockRejectedValue(new Error("401"));
    stop = startLive({ onChange: (w) => changes.push(w), probe, open: s.open });
    await vi.advanceTimersByTimeAsync(0);
    s.last().send("event: ready\ndata: {\"v\":1}\n\nevent: bye\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.last().signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(s.conns.length).toBe(1); // no stream while the probe fails
  });

  it("a silent connection is given up; held back streams turn into polling until one gets through", async () => {
    const { startLive } = await import("./live");
    const s = opener();
    stop = startLive({ onChange: (w) => changes.push(w), probe, open: s.open, readyWithin: 1000, idleWithin: 3000, pollAfter: 2, pollEvery: 5000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.conns[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000 + 2000); // the second one is held back too
    expect(s.conns.length).toBe(2);
    expect(s.conns[1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes[0]).toEqual(["items", "trash", "albums"]);
    const opened = s.conns.length;
    while (s.conns.length === opened) await vi.advanceTimersByTimeAsync(100);
    s.last().send("event: ready\ndata: {\"v\":1}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    const n = changes.length;
    // heartbeats keep it; then silence for longer than idleWithin ends it
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(2000); s.last().send(":\n\n"); }
    expect(changes.length).toBe(n); // no more polling
    expect(s.last().signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.last().signal.aborted).toBe(true);
  });
});

describe("only on screen and unlocked", () => {
  beforeEach(() => {
    vi.resetModules();
    st.appState = "active";
    st.listeners = [];
  });

  it("streams while both hold, and stops when the app leaves the screen or locks", async () => {
    const live = await import("./live");
    const s = opener();
    live.watchLive({ onChange: () => {}, probe: async () => ({}), open: s.open });
    await Promise.resolve();
    expect(s.conns.length).toBe(0); // locked
    live.liveUnlocked(true);
    await Promise.resolve();
    expect(s.conns.length).toBe(1);
    st.listeners.forEach((f) => f("background"));
    expect(s.conns[0].signal.aborted).toBe(true);
    st.listeners.forEach((f) => f("active"));
    await Promise.resolve();
    expect(s.conns.length).toBe(2);
    live.liveUnlocked(false);
    expect(s.conns[1].signal.aborted).toBe(true);
    st.listeners.forEach((f) => f("active"));
    await Promise.resolve();
    expect(s.conns.length).toBe(2);
  });
});
