// Live updates: the server tells this tab (GET /api/events, Server-Sent Events) when something in the account changed
// on another device, a photo uploaded on the phone, an album renamed on the Mac, and the library loads again what
// changed. A ping says only which lists changed (never what is in them); the lists come through the usual API.

export type Topic = "items" | "trash" | "albums" | "people" | "index";
export const ALL: Topic[] = ["items", "trash", "albums", "people", "index"];
const TOPICS = new Set<string>(ALL);

interface Clock {
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (t: any) => void;
  now: () => number;
}
const realClock: Clock = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() };

/** Runs `run` for what was pinged: `delay` after the first ping (so a burst arrives as one), never two at once, and
 *  at least `gap` apart or twice as long as the last run took (a big library takes a while to load; another device's
 *  import must not keep this one loading it). Pings that come in meanwhile are merged into the next run. */
export function coalesce(run: (what: Set<Topic>) => Promise<unknown>, opts: { delay?: number; gap?: number } = {}, clock: Clock = realClock) {
  const delay = opts.delay ?? 300, gap = opts.gap ?? 1500;
  let pending = new Set<Topic>();
  let timer: unknown = null;
  let running = false;
  let lastEnd = -Infinity, lastTook = 0;
  let stopped = false;
  const schedule = () => {
    if (timer !== null || running || stopped || !pending.size) return;
    timer = clock.setTimeout(fire, Math.max(delay, lastEnd + Math.max(gap, 2 * lastTook) - clock.now()));
  };
  const fire = async () => {
    timer = null;
    if (stopped) return;
    const what = pending;
    pending = new Set();
    running = true;
    const began = clock.now();
    try { await run(what); } catch { /* the next ping tries again */ }
    running = false;
    lastEnd = clock.now();
    lastTook = lastEnd - began;
    schedule();
  };
  return {
    ping(what: Iterable<Topic>) { for (const t of what) pending.add(t); schedule(); },
    stop() { stopped = true; if (timer !== null) clock.clearTimeout(timer); timer = null; },
  };
}

/** What the tab needs of an EventSource (a stand-in in the tests). */
export interface Source {
  addEventListener(type: string, f: (e: MessageEvent) => void): void;
  onerror: ((e: Event) => void) | null;
  close(): void;
}

export interface LiveOptions {
  /** Called with what changed; after a reconnect that may have missed pings, with everything. */
  onChange: (what: Topic[]) => void;
  /** An ordinary request, before reconnecting: it fails while the server is away, and a session that ended is noticed
   *  the usual way (api.ts), which EventSource can't do (it doesn't show the status of a refused answer). It also
   *  checks that the session is still this tab's (auth.checkSession): a sign-in meanwhile may have replaced it. */
  probe: () => Promise<unknown>;
  open?: (url: string) => Source;
  clock?: Clock;
  /** no "ready" this long after opening: something on the way holds the stream back (a proxy that buffers) */
  readyWithin?: number;
  /** after that many held-back streams in a row, the lists are loaded every pollEvery instead, until a stream works */
  pollAfter?: number;
  pollEvery?: number;
}

/** Keeps a live-update stream open until the returned function is called; reconnects with backoff. */
export function startLive(o: LiveOptions): () => void {
  const clock = o.clock ?? realClock;
  const open = o.open ?? ((url: string) => new EventSource(url) as unknown as Source);
  const readyWithin = o.readyWithin ?? 10_000, pollAfter = o.pollAfter ?? 3, pollEvery = o.pollEvery ?? 15_000;
  let es: Source | null = null;
  let lastV: number | undefined;
  let tries = 0; // failed connections in a row
  let heldBack = 0; // streams in a row that opened but never said "ready"
  let timer: unknown = null, watchdog: unknown = null, poller: unknown = null;
  let stopped = false;

  const clear = (t: unknown) => { if (t !== null) clock.clearTimeout(t); };
  const close = () => { es?.close(); es = null; clear(watchdog); watchdog = null; };
  const poll = (on: boolean) => {
    if (!on || stopped) { clear(poller); poller = null; return; }
    if (poller !== null) return;
    const tick = () => { poller = clock.setTimeout(tick, pollEvery); o.onChange(["items", "trash", "albums"]); };
    poller = clock.setTimeout(tick, pollEvery);
  };
  const retry = () => {
    close();
    if (stopped || timer !== null) return;
    // 1, 2, 4 … 60 seconds, a little random so many tabs don't come back at the same moment after a restart
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(tries, 6)) * (0.8 + Math.random() * 0.4);
    tries++;
    timer = clock.setTimeout(attempt, wait);
  };
  const attempt = async () => {
    timer = null;
    try { await o.probe(); } catch { if (!stopped) retry(); return; }
    connect();
  };
  const data = (e: MessageEvent): { v?: number; what?: unknown } => { try { return JSON.parse(e.data); } catch { return {}; } };
  const connect = () => {
    if (stopped) return;
    close();
    const s = open("/api/events");
    es = s;
    watchdog = clock.setTimeout(() => {
      watchdog = null;
      if (es !== s) return;
      if (++heldBack >= pollAfter) poll(true);
      retry();
    }, readyWithin);
    s.addEventListener("ready", (e) => {
      if (es !== s) return;
      clear(watchdog); watchdog = null;
      tries = 0; heldBack = 0; poll(false);
      const v = data(e).v;
      // a stream that was gone a while may have missed pings: load everything if the account changed meanwhile
      // (or the server restarted, which starts its counters anew)
      if (lastV !== undefined && v !== lastV) o.onChange(ALL);
      lastV = v;
    });
    s.addEventListener("changed", (e) => {
      if (es !== s) return;
      const d = data(e);
      if (typeof d.v === "number") lastV = d.v;
      const what = Array.isArray(d.what) ? d.what.filter((x): x is Topic => typeof x === "string" && TOPICS.has(x)) : [];
      o.onChange(what.length ? what : ALL);
    });
    // the session ended (signed out here or from another device): the probe before reconnecting tells the app
    s.addEventListener("bye", () => { if (es === s) retry(); });
    // EventSource reconnects by itself after a dropped connection, but gives up on a refused one (401, 429); this
    // does both the same way, with the probe first
    s.onerror = () => { if (es === s) retry(); };
  };

  const back = () => {
    // back online, or the tab shown again: a stream waiting for its next try goes at once
    if (stopped || es || timer === null || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    clear(timer); tries = 0;
    void attempt();
  };
  if (typeof window !== "undefined") window.addEventListener("online", back);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", back);
  connect();
  return () => {
    stopped = true;
    close(); clear(timer); timer = null; poll(false);
    if (typeof window !== "undefined") window.removeEventListener("online", back);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", back);
  };
}
