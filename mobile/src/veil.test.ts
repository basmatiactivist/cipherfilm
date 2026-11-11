import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Veil } from "./veil";

const it3 = (...ids: string[]) => ids.map((id) => ({ id, has_thumb: true }));

describe("the library's loading veil", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lifts when every thumbnail of the first screen was shown", () => {
    const lift = vi.fn();
    const v = new Veil(lift, 12_000);
    v.update(it3("a", "b"));
    v.shown("a");
    expect(lift).not.toHaveBeenCalled();
    v.shown("b");
    expect(lift).toHaveBeenCalledTimes(1);
    v.shown("c");
    vi.advanceTimersByTime(20_000);
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it("lifts at once without thumbnails to wait for, or ones already shown", () => {
    const lift = vi.fn();
    new Veil(lift, 12_000).update([{ id: "a", has_thumb: false }, { id: "b", has_thumb: true, broken: true }]);
    expect(lift).toHaveBeenCalledTimes(1);
    const lift2 = vi.fn();
    const v = new Veil(lift2, 12_000);
    v.shown("a"); // drawn before the list was handed over
    v.update(it3("a"));
    expect(lift2).toHaveBeenCalledTimes(1);
  });

  it("keeps its deadline when the list changes while it waits (the stuck badge after an update)", () => {
    const lift = vi.fn();
    const v = new Veil(lift, 12_000);
    v.update(it3("a", "b"));
    vi.advanceTimersByTime(6_000);
    v.update(it3("n1", "n2", "a")); // the server's list: new items on top
    vi.advanceTimersByTime(5_999);
    expect(lift).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it("waits for the first screen as it is now, not for items pushed off it", () => {
    const lift = vi.fn();
    const v = new Veil(lift, 12_000);
    v.update(it3("a", "b"));
    v.shown("a");
    v.update(it3("n1", "a")); // b is no longer on the first screen: it is never drawn
    v.shown("n1");
    expect(lift).toHaveBeenCalledTimes(1);
  });

  it("doesn't lift before the list arrived, and not after the screen went away", () => {
    const lift = vi.fn();
    const v = new Veil(lift, 12_000);
    v.shown("a");
    vi.advanceTimersByTime(20_000);
    expect(lift).not.toHaveBeenCalled();
    v.update(it3("b"));
    v.dispose();
    vi.advanceTimersByTime(20_000);
    expect(lift).not.toHaveBeenCalled();
  });
});
