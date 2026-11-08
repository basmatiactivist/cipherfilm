import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taps } from "./taps";

// The viewer's taps: one tap shows or hides the bars only once it is clear no second tap follows; two quick taps zoom
// and never also toggle the bars.
describe("taps on a photo", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const setup = () => {
    const single = vi.fn(), double = vi.fn();
    return { single, double, t: taps<string>(single, double, 300, () => Date.now()) };
  };

  it("one tap: the bars toggle after the wait, not before", () => {
    const { single, double, t } = setup();
    t.tap("a");
    vi.advanceTimersByTime(299);
    expect(single).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(single).toHaveBeenCalledTimes(1);
    expect(double).not.toHaveBeenCalled();
  });

  it("two quick taps: a zoom where the second one was, and no toggle", () => {
    const { single, double, t } = setup();
    t.tap("a");
    vi.advanceTimersByTime(200);
    t.tap("b");
    vi.advanceTimersByTime(1000);
    expect(double).toHaveBeenCalledWith("b");
    expect(single).not.toHaveBeenCalled();
  });

  it("two slow taps: two toggles", () => {
    const { single, double, t } = setup();
    t.tap("a");
    vi.advanceTimersByTime(400);
    t.tap("b");
    vi.advanceTimersByTime(400);
    expect(single).toHaveBeenCalledTimes(2);
    expect(double).not.toHaveBeenCalled();
  });

  it("three quick taps: a zoom, then the third starts over", () => {
    const { single, double, t } = setup();
    t.tap("a"); vi.advanceTimersByTime(100);
    t.tap("b"); vi.advanceTimersByTime(100);
    t.tap("c"); vi.advanceTimersByTime(400);
    expect(double).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("cancelled (swiped away): the waiting tap does nothing", () => {
    const { single, t } = setup();
    t.tap("a");
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(single).not.toHaveBeenCalled();
  });
});
