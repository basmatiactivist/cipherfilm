import { describe, expect, it } from "vitest";
import { BATCH, inBatches } from "./items";

describe("inBatches", () => {
  it("never sends more ids than the server takes in one request", async () => {
    const ids = Array.from({ length: 1234 }, (_, i) => i.toString(16).padStart(32, "0"));
    const sent: string[][] = [];
    await inBatches(ids, async (part) => { sent.push(part); });
    expect(sent.map((p) => p.length)).toEqual([BATCH, BATCH, 1234 - 2 * BATCH]);
    expect(sent.flat()).toEqual(ids);
  });

  it("sends one request for a small selection and stops at the first failure", async () => {
    const calls: number[] = [];
    await inBatches(["a"], async (part) => { calls.push(part.length); });
    expect(calls).toEqual([1]);
    const ids = Array.from({ length: 1200 }, (_, i) => String(i));
    let n = 0;
    await expect(inBatches(ids, async () => { if (++n === 2) throw new Error("server says no"); })).rejects.toThrow("server says no");
    expect(n).toBe(2);
  });
});
