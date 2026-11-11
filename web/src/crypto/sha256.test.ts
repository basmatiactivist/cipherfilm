// @ts-nocheck (Node APIs for the reference digest; vitest only)
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Sha256, SHA256_HEX } from "./sha256";

const ref = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => { const u = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; u[i] = x >>> 24; } return u; };

describe("sha256", () => {
  it("matches the known answers", () => {
    expect(new Sha256().hex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("gives the same digest however the input is split", () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const b = bytes(n, n);
      const whole = new Sha256().update(b).hex();
      expect(whole).toBe(ref(b));
      const parts = new Sha256();
      for (let i = 0, step = 1; i < n; i += step, step = (step * 7 + 3) % 97 + 1) parts.update(b.subarray(i, Math.min(n, i + step)));
      expect(parts.hex()).toBe(whole);
      expect(whole).toMatch(SHA256_HEX);
    }
  });

  it("can't be used after it finished", () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.update(new Uint8Array(1))).toThrow();
    expect(() => h.digest()).toThrow();
  });
});
