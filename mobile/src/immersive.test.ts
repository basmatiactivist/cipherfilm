import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ native: [] as boolean[], status: [] as boolean[], hasNative: true }));
vi.mock("react-native", () => ({ StatusBar: { setHidden: (h: boolean) => { calls.status.push(h); } } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({
  default: new Proxy({}, { get: (_t, k) => (k === "systemBars" && calls.hasNative ? (h: boolean) => { calls.native.push(h); } : undefined) }),
}));
const { hideSystemBars, largestInsets } = await import("./immersive");

describe("the viewer's full screen", () => {
  it("hides and shows both system bars through the app's module", () => {
    hideSystemBars(true); hideSystemBars(false);
    expect(calls.native).toEqual([true, false]);
    expect(calls.status).toEqual([]);
  });

  it("without it (an older installed app), at least the status bar", () => {
    calls.hasNative = false;
    hideSystemBars(true);
    expect(calls.status).toEqual([true]);
    calls.hasNative = true;
  });

  it("keeps the room the system bars take while they are hidden", () => {
    const shown = { top: 32, bottom: 24, left: 0, right: 0 };
    const hidden = { top: 0, bottom: 0, left: 0, right: 0 };
    const kept = largestInsets(hidden, shown);
    expect(kept).toEqual(shown);
    expect(largestInsets(kept, hidden)).toBe(kept); // the same object: nothing re-renders
    expect(largestInsets(kept, { ...shown, bottom: 48 })).toEqual({ ...shown, bottom: 48 });
  });
});
