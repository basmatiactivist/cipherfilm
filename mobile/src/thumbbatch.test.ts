import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitThumbs, ThumbBatcher } from "./thumbbatch";

// the server's answer: u32 big-endian length and the bytes for each id, 0xFFFFFFFF for none
function answer(parts: (number[] | null)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    const n = p ? p.length : 0xffffffff;
    out.push(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...(p ?? []));
  }
  return new Uint8Array(out);
}

describe("splitThumbs", () => {
  it("returns each id's bytes in order, null where the server has none", () => {
    const got = splitThumbs(answer([[1, 2, 3], null, [], [9]]), 4);
    expect(got.map((x) => (x ? [...x] : null))).toEqual([[1, 2, 3], null, [], [9]]);
  });

  it("gives copies, not views of the whole answer", () => {
    const got = splitThumbs(answer([[5, 6]]), 1)[0]!;
    expect(got.byteOffset).toBe(0);
    expect(got.buffer.byteLength).toBe(2);
  });

  it("treats a cut-short answer as missing from there on", () => {
    const full = answer([[1, 2], [3, 4, 5], [6]]);
    const got = splitThumbs(full.subarray(0, 4 + 2 + 4 + 1), 3);
    expect(got.map((x) => (x ? [...x] : null))).toEqual([[1, 2], null, null]);
    expect(splitThumbs(new Uint8Array(0), 2)).toEqual([null, null]);
    expect(splitThumbs(new Uint8Array([0, 0]), 1)).toEqual([null]);
  });

  it("ignores bytes past the ids asked for", () => {
    expect(splitThumbs(answer([[1], [2]]), 1).map((x) => [...x!])).toEqual([[1]]);
  });

  it("reads a length as unsigned", () => {
    // 0x80000000 is longer than any answer: cut short, not a negative length
    expect(splitThumbs(new Uint8Array([0x80, 0, 0, 0, 1, 2]), 1)).toEqual([null]);
  });
});

describe("ThumbBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const bytes = (id: string) => [...new TextEncoder().encode(id)];
  const ok = (ids: string[]) => answer(ids.map((id) => (id.startsWith("none") ? null : bytes(id))));
  const text = (p: Promise<Uint8Array>) => p.then((b) => new TextDecoder().decode(b), (e: Error) => `error: ${e.message}`);

  it("asks once for everything requested within the window, newest first", async () => {
    const many = vi.fn(async (ids: string[]) => ok(ids));
    const one = vi.fn();
    const b = new ThumbBatcher(many, one);
    const got = ["a", "b", "none1", "c"].map((id) => text(b.get(id, () => true)));
    await vi.advanceTimersByTimeAsync(20);
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0][0]).toEqual(["c", "none1", "b", "a"]);
    expect(await Promise.all(got)).toEqual(["a", "b", "error: no thumbnail", "c"]);
    expect(one).not.toHaveBeenCalled();
  });

  it("skips what nobody wants any more and asks for a thumbnail once", async () => {
    const many = vi.fn(async (ids: string[]) => ok(ids));
    const b = new ThumbBatcher(many, vi.fn());
    const gone = text(b.get("x", () => false));
    const first = text(b.get("y", () => false));
    const again = text(b.get("y", () => true));
    await vi.advanceTimersByTimeAsync(20);
    expect(many.mock.calls[0][0]).toEqual(["y"]);
    expect(await Promise.all([gone, first, again])).toEqual(["error: cancelled", "y", "y"]);
  });

  it("sends at most 100 a request", async () => {
    const many = vi.fn(async (ids: string[]) => ok(ids));
    const b = new ThumbBatcher(many, vi.fn());
    const all = Array.from({ length: 250 }, (_, i) => b.get(`i${i}`, () => true));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all(all);
    expect(many.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
  });

  it("falls back to one request each against a server without the endpoint", async () => {
    const many = vi.fn(async () => { throw Object.assign(new Error("not found"), { status: 404 }); });
    const one = vi.fn(async (id: string) => new TextEncoder().encode("single " + id));
    const b = new ThumbBatcher(many, one);
    const got = [text(b.get("a", () => true)), text(b.get("b", () => true))];
    await vi.advanceTimersByTimeAsync(20);
    expect(await Promise.all(got)).toEqual(["single a", "single b"]);
    // from then on without waiting for a batch
    expect(await text(b.get("c", () => true))).toBe("single c");
    expect(many).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledTimes(3);
  });

  it("passes other errors on and keeps batching", async () => {
    let fail = true;
    const many = vi.fn(async (ids: string[]) => { if (fail) { fail = false; throw Object.assign(new Error("offline"), { status: 0 }); } return ok(ids); });
    const b = new ThumbBatcher(many, vi.fn());
    const first = text(b.get("a", () => true));
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe("error: offline");
    const second = text(b.get("a", () => true));
    await vi.advanceTimersByTimeAsync(20);
    expect(await second).toBe("a");
  });
});
