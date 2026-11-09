import { describe, expect, it, vi } from "vitest";
import { bounded } from "./bounded";

describe("bounded", () => {
  it("passes on what answers in time", async () => {
    await expect(bounded(Promise.resolve(7), 1000)).resolves.toBe(7);
    await expect(bounded(Promise.reject(new Error("no")), 1000)).rejects.toThrow("no");
  });
  it("fails a call that never answers, so the upload and the backup run can end", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<number>(() => {});
      const p = bounded(never, 90_000);
      const seen = expect(p).rejects.toThrow("took too long");
      await vi.advanceTimersByTimeAsync(90_000);
      await seen;
    } finally {
      vi.useRealTimers();
    }
  });
});
