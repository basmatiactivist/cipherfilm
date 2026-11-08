import { describe, expect, it } from "vitest";
import { coalesce } from "./coalesce";

describe("coalesce", () => {
  it("runs once at a time, and once more for all the calls that came meanwhile", async () => {
    let runs = 0, open = 0, most = 0;
    let release: () => void = () => {};
    const f = coalesce(async () => {
      runs++; most = Math.max(most, ++open);
      await new Promise<void>((r) => { release = r; });
      open--;
    });
    const a = f();
    f(); f(); f();
    release(); await Promise.resolve(); await Promise.resolve();
    release();
    await a;
    expect(runs).toBe(2);
    expect(most).toBe(1);
    // and again later as usual
    const b = f(); release(); await b;
    expect(runs).toBe(3);
  });

  it("a failing run doesn't keep the next calls from running", async () => {
    let runs = 0;
    const f = coalesce(async () => { runs++; if (runs === 1) throw new Error("x"); });
    await expect(f()).rejects.toThrow("x");
    await f();
    expect(runs).toBe(2);
  });
});
