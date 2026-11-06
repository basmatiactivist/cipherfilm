import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, dropRequests, Dropped, getBytes, postForBytes, putBytes } from "./api";

// fetch stand-in: each call waits until the test answers it, and honours the abort signal like a browser
type Call = { path: string; init: RequestInit; answer: (r: Response) => void };
let calls: Call[] = [];
const events: string[] = [];

beforeEach(() => {
  calls = [];
  events.length = 0;
  vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => new Promise<Response>((ok, bad) => {
    init.signal?.addEventListener("abort", () => bad(new DOMException("aborted", "AbortError")));
    calls.push({ path, init, answer: ok });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** A 200 whose body breaks off while it is read (a reload, a lost connection, an abort). */
const cutOff = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"items":[')); c.error(new TypeError("network error")); } }), { status: 200 });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("api", () => {
  it("returns the answer, and null for an empty one", async () => {
    const a = api("GET", "/api/items");
    const b = api("POST", "/api/x");
    await tick();
    calls[0].answer(json(200, { items: [1] }));
    calls[1].answer(new Response(null, { status: 200 }));
    expect(await a).toEqual({ items: [1] });
    expect(await b).toBeNull();
  });

  it("an answer cut off while it is read fails instead of looking like an empty success", async () => {
    const p = api("GET", "/api/items");
    await tick();
    calls[0].answer(cutOff());
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });

  it("a 200 that isn't JSON fails", async () => {
    const p = api("GET", "/api/albums");
    await tick();
    calls[0].answer(new Response("<html>", { status: 200 }));
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });

  it("drops what was on its way at lock or sign-out, without reporting an ended session", async () => {
    const p = api("GET", "/api/items");
    const b = getBytes("/api/items/x/preview");
    const t = postForBytes("/api/items/thumbs", { item_ids: [] });
    await tick();
    dropRequests();
    await expect(p).rejects.toBeInstanceOf(Dropped);
    await expect(b).rejects.toBeInstanceOf(Dropped);
    await expect(t).rejects.toBeInstanceOf(Dropped);
    expect(events).toEqual([]);
  });

  it("a late 401 after the drop is not taken for an ended session", async () => {
    const p = api("GET", "/api/index");
    await tick();
    const late = calls[0];
    dropRequests();
    late.answer(json(401, { error: "not signed in" }));
    await expect(p).rejects.toBeInstanceOf(Dropped);
    expect(events).toEqual([]);
  });

  it("a 401 of the current session still ends it", async () => {
    const p = api("GET", "/api/items");
    await tick();
    calls[0].answer(json(401, { error: "not signed in" }));
    await expect(p).rejects.toMatchObject({ status: 401 });
    expect(events).toEqual(["cf-session-ended"]);
  });

  it("requests after the drop run normally", async () => {
    dropRequests();
    const p = api("GET", "/api/items");
    await tick();
    calls[0].answer(json(200, { items: [] }));
    expect(await p).toEqual({ items: [] });
  });

  it("a request with its own deadline (telling the server about a sign-out) outlives the drop", async () => {
    const p = api("POST", "/api/auth/logout", undefined, { timeout: 10_000, keepalive: true });
    await tick();
    dropRequests();
    expect(calls[0].init.keepalive).toBe(true);
    calls[0].answer(json(200, { ok: true }));
    expect(await p).toEqual({ ok: true });
  });

  it("an upload part stops retrying once the session is gone", async () => {
    vi.useFakeTimers();
    try {
      const p = putBytes("/api/items/x/segments/0", new Uint8Array(1));
      const done = expect(p).rejects.toBeInstanceOf(Dropped);
      await vi.advanceTimersByTimeAsync(0);
      calls[0].answer(json(503, { error: "busy" }));
      await vi.advanceTimersByTimeAsync(0);
      dropRequests();
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
