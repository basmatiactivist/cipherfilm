// Live updates: while the app is on screen and unlocked, the server tells it (GET /api/events, Server-Sent Events read
// from a streaming fetch) when something in the account changed on another device, and the app loads again what
// changed: a photo uploaded on the Mac shows here within a second or two. Nothing streams in the background (battery,
// and Android's rules for apps that aren't on screen): the stream ends when the app leaves the screen or locks, and
// the first answer after coming back says whether anything changed meanwhile.
import { fetch } from "expo/fetch";
import { AppState } from "react-native";
import { server } from "./api";

// "notices": a new sign-in or an admin's change for the person to see (notices.ts)
export type Topic = "items" | "trash" | "albums" | "people" | "index" | "notices";
export const ALL: Topic[] = ["items", "trash", "albums", "people", "index", "notices"];
const TOPICS = new Set<string>(ALL);

/** One event of the stream; a heartbeat (a comment line) has the name ":". */
export interface SSEvent { event: string; data: string }

/** Splits the stream's text into events, whatever pieces it arrives in. */
export function sseParser() {
  let buf = "", event = "", data: string[] = [], comment = false;
  return (chunk: string): SSEvent[] => {
    const out: SSEvent[] = [];
    buf += chunk;
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      if (nl === buf.length - 1 && buf[nl] === "\r") break; // the "\n" of a "\r\n" may be in the next piece
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (data.length || event) out.push({ event: event || "message", data: data.join("\n") });
        else if (comment) out.push({ event: ":", data: "" });
        event = ""; data = []; comment = false;
      } else if (line.startsWith(":")) comment = true;
      else {
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    return out;
  };
}

/** Runs `run` for what was pinged: `delay` after the first ping, never two at once, and at least `gap` apart or twice
 *  as long as the last run took. Pings that come in meanwhile are merged into the next run. (As web/src/live.ts.) */
export function coalesce(run: (what: Set<Topic>) => Promise<unknown>, opts: { delay?: number; gap?: number } = {}) {
  const delay = opts.delay ?? 300, gap = opts.gap ?? 2000;
  let pending = new Set<Topic>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false, stopped = false;
  let lastEnd = -Infinity, lastTook = 0;
  const schedule = () => {
    if (timer !== null || running || stopped || !pending.size) return;
    timer = setTimeout(fire, Math.max(delay, lastEnd + Math.max(gap, 2 * lastTook) - Date.now()));
  };
  const fire = async () => {
    timer = null;
    if (stopped) return;
    const what = pending;
    pending = new Set();
    running = true;
    const began = Date.now();
    try { await run(what); } catch { /* the next ping tries again */ }
    running = false;
    lastEnd = Date.now();
    lastTook = lastEnd - began;
    schedule();
  };
  return {
    ping(what: Iterable<Topic>) { for (const t of what) pending.add(t); schedule(); },
    stop() { stopped = true; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}

/** Opens the stream; resolves with its body once the server answered 200. */
export type Opener = (signal: AbortSignal) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
const openStream: Opener = (signal) => fetch(server() + "/api/events", { credentials: "include", headers: { Accept: "text/event-stream" }, signal });

export interface LiveOptions {
  onChange: (what: Topic[]) => void;
  /** An ordinary API request before each reconnect: it fails while the server is away, and a session that ended is
   *  noticed by api.ts as with any other request. */
  probe: () => Promise<unknown>;
  open?: Opener;
  /** the account's counter, kept across streams: after the app was away, a different one means something changed */
  memory?: { v?: number };
  /** no "ready" this long after asking: something on the way holds the stream back (a proxy that buffers) */
  readyWithin?: number;
  /** nothing at all this long (the server sends a heartbeat every 25 s): the connection is dead */
  idleWithin?: number;
  pollAfter?: number;
  pollEvery?: number;
}

/** Keeps a stream open until the returned function is called; reconnects with backoff, and loads the lists every
 *  pollEvery instead while streams keep being held back. */
export function startLive(o: LiveOptions): () => void {
  const open = o.open ?? openStream;
  const memory = o.memory ?? {};
  const readyWithin = o.readyWithin ?? 10_000, idleWithin = o.idleWithin ?? 60_000;
  const pollAfter = o.pollAfter ?? 3, pollEvery = o.pollEvery ?? 15_000;
  let stopped = false;
  let ctl: AbortController | null = null;
  let tries = 0, heldBack = 0;
  let wait: ReturnType<typeof setTimeout> | null = null, poller: ReturnType<typeof setTimeout> | null = null;

  const poll = (on: boolean) => {
    if (!on || stopped) { if (poller) clearTimeout(poller); poller = null; return; }
    if (poller) return;
    const tick = () => { poller = setTimeout(tick, pollEvery); o.onChange(["items", "trash", "albums"]); };
    poller = setTimeout(tick, pollEvery);
  };
  const later = () => {
    if (stopped) return;
    const ms = Math.min(60_000, 1000 * 2 ** Math.min(tries, 6)) * (0.8 + Math.random() * 0.4);
    tries++;
    wait = setTimeout(async () => {
      wait = null;
      try { await o.probe(); } catch { later(); return; }
      run();
    }, ms);
  };
  const handle = (ev: SSEvent): boolean => {
    let d: { v?: unknown; what?: unknown } = {};
    try { d = ev.data ? JSON.parse(ev.data) : {}; } catch { /* not ours */ }
    const v = typeof d.v === "number" ? d.v : undefined;
    if (ev.event === "ready") {
      tries = 0; heldBack = 0; poll(false);
      if (memory.v !== undefined && v !== memory.v) o.onChange(ALL);
      memory.v = v;
    } else if (ev.event === "changed") {
      if (v !== undefined) memory.v = v;
      const what = Array.isArray(d.what) ? d.what.filter((x): x is Topic => typeof x === "string" && TOPICS.has(x)) : [];
      o.onChange(what.length ? what : ALL);
    } else if (ev.event === "bye") return false; // the session ended: the probe before reconnecting tells the app
    return true;
  };
  const run = async () => {
    if (stopped) return;
    const c = new AbortController();
    ctl = c;
    let ready = false;
    let idle = setTimeout(() => { if (!ready) heldBack++; c.abort(); }, readyWithin);
    const alive = (ms: number) => { clearTimeout(idle); idle = setTimeout(() => c.abort(), ms); };
    try {
      const res = await open(c.signal);
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parse = sseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let more = true;
        for (const ev of parse(dec.decode(value, { stream: true }))) {
          if (ev.event === "ready") ready = true;
          if (!handle(ev)) more = false;
        }
        if (!more) { c.abort(); break; }
        if (ready) alive(idleWithin);
      }
    } catch { /* dropped, refused, timed out or stopped */ }
    clearTimeout(idle);
    if (ctl === c) ctl = null;
    if (stopped) return;
    if (heldBack >= pollAfter) poll(true);
    later();
  };
  run();
  return () => {
    stopped = true;
    ctl?.abort(); ctl = null;
    if (wait) clearTimeout(wait);
    wait = null;
    poll(false);
  };
}

// ---- on screen and unlocked only ----

let unlocked = false;
let onScreen = AppState.currentState === "active";
let stopStream: (() => void) | null = null;
let options: Omit<LiveOptions, "memory"> | null = null;
const memory: { v?: number } = {};

function update() {
  const want = !!options && unlocked && onScreen;
  if (want && !stopStream) stopStream = startLive({ ...options!, memory });
  else if (!want && stopStream) { stopStream(); stopStream = null; }
}

/** Starts watching (once, from the root layout); the stream runs while the app is on screen and unlocked. */
export function watchLive(o: Omit<LiveOptions, "memory">) {
  if (options) return;
  options = o;
  AppState.addEventListener("change", (s) => { onScreen = s === "active"; update(); });
  update();
}

/** The library was unlocked or locked (the root layout follows the session). After a lock the lists load anew at
 *  the next unlock anyway, so the counter is forgotten with them. */
export function liveUnlocked(on: boolean) {
  if (!on) memory.v = undefined;
  unlocked = on;
  update();
}
