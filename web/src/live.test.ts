import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL, coalesce, startLive, type Source, type Topic } from "./live";

describe("coalesce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs once for a burst, with everything it named", async () => {
    const runs: Topic[][] = [];
    const c = coalesce(async (w) => { runs.push([...w].sort()); }, { delay: 300, gap: 1500 });
    c.ping(["items"]); c.ping(["albums"]); c.ping(["items"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual([["albums", "items"]]);
  });

  it("never runs twice at once, and leaves the gap between runs", async () => {
    let busy = 0, most = 0;
    const at: number[] = [];
    const c = coalesce(async () => { busy++; most = Math.max(most, busy); at.push(Date.now()); await new Promise((r) => setTimeout(r, 1000)); busy--; }, { delay: 100, gap: 1500 });
    const t0 = Date.now();
    c.ping(["items"]);
    await vi.advanceTimersByTimeAsync(200); // running now
    c.ping(["trash"]); c.ping(["items"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(most).toBe(1);
    expect(at.map((t) => t - t0)).toEqual([100, 100 + 1000 + 2000]); // the run took 1 s: twice that, more than the gap
  });

  it("stops", async () => {
    const run = vi.fn(async () => {});
    const c = coalesce(run);
    c.ping(["items"]);
    c.stop();
    c.ping(["items"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

class FakeSource implements Source {
  static all: FakeSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSource.all.push(this); }
  addEventListener(type: string, f: (e: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const f of this.listeners.get(type) ?? []) f({ data: JSON.stringify(data) } as MessageEvent); }
  fail() { this.onerror?.(new Event("error")); }
}
const last = () => FakeSource.all[FakeSource.all.length - 1];

describe("startLive", () => {
  let changes: Topic[][];
  let probe: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  let stop: () => void;
  const start = (o: Partial<Parameters<typeof startLive>[0]> = {}) => {
    stop = startLive({ onChange: (w) => changes.push(w), probe, open: (u) => new FakeSource(u), ...o });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
    changes = [];
    probe = vi.fn(async () => ({}));
    vi.spyOn(Math, "random").mockReturnValue(0.5); // the backoff without its jitter
  });
  afterEach(() => { stop?.(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("passes on what changed, and only names it knows", () => {
    start();
    expect(last().url).toBe("/api/events");
    last().emit("ready", { v: 5 });
    expect(changes).toEqual([]); // the library has just loaded
    last().emit("changed", { v: 6, what: ["items", "albums"] });
    last().emit("changed", { v: 7, what: ["bogus", "trash"] });
    last().emit("changed", { v: 8, what: [] });
    expect(changes).toEqual([["items", "albums"], ["trash"], ALL]);
  });

  it("reconnects after a drop with a probe first, and loads everything only if something changed meanwhile", async () => {
    start();
    const first = last();
    first.emit("ready", { v: 5 });
    first.fail();
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1300);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(FakeSource.all.length).toBe(2);
    last().emit("ready", { v: 5 });
    expect(changes).toEqual([]);
    last().fail();
    await vi.advanceTimersByTimeAsync(1300); // tries start again from 1 s after a stream that worked
    last().emit("ready", { v: 9 });
    expect(changes).toEqual([ALL]);
  });

  it("backs off while the server is away, and doesn't open a stream until it answers", async () => {
    probe.mockRejectedValue(new Error("offline"));
    start();
    last().fail();
    await vi.advanceTimersByTimeAsync(1300);
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(4900);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(FakeSource.all.length).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); // the fourth try waits 8 s (± 20 %)
    expect(probe).toHaveBeenCalledTimes(3);
    probe.mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(FakeSource.all.length).toBe(2);
  });

  it("asks again after the server said goodbye (the session ended), so the app notices", async () => {
    start();
    last().emit("ready", { v: 1 });
    last().emit("bye", {});
    expect(last().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1300);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("loads the lists every few seconds while something holds the stream back, until one gets through", async () => {
    start({ readyWithin: 1000, pollAfter: 2, pollEvery: 5000 });
    await vi.advanceTimersByTimeAsync(1000); // no ready: held back once
    await vi.advanceTimersByTimeAsync(1300);
    expect(FakeSource.all.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // twice: polling starts
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]).toEqual(["items", "trash", "albums"]);
    // the next stream that opens gets through
    const opened = FakeSource.all.length;
    while (FakeSource.all.length === opened) await vi.advanceTimersByTimeAsync(100);
    last().emit("ready", { v: 3 });
    const n = changes.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(changes.length).toBe(n);
  });

  it("stops: the stream closes and nothing comes back", async () => {
    start();
    const s = last();
    stop();
    expect(s.closed).toBe(true);
    s.fail();
    s.emit("changed", { v: 2, what: ["items"] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSource.all.length).toBe(1);
    expect(changes).toEqual([]);
  });
});
