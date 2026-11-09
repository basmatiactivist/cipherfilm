import { describe, expect, it } from "vitest";
import { freshReload, RELOAD_MS } from "./keep";

describe("kept key", () => {
  const now = 1_000_000;
  it("counts only for a reload right after the page was left", () => {
    expect(freshReload("reload", now - 800, now)).toBe(true);
  });
  it("not for a reopened tab, a restored session or a new page", () => {
    expect(freshReload("back_forward", now - 800, now)).toBe(false);
    expect(freshReload("navigate", now - 800, now)).toBe(false);
    expect(freshReload(undefined, now - 800, now)).toBe(false);
  });
  it("not when the page was left long ago or never", () => {
    expect(freshReload("reload", now - RELOAD_MS, now)).toBe(false);
    expect(freshReload("reload", undefined, now)).toBe(false);
    expect(freshReload("reload", now + 5_000, now)).toBe(false);
  });
});
