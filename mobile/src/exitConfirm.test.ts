import { describe, expect, it } from "vitest";
import { shouldAsk } from "./exitConfirm";

describe("ask before Back closes the app", () => {
  it("asks on the top-level places when nothing is under them", () => {
    for (const top of ["library", "search", "albums", "map"]) expect(shouldAsk({ top, canGoBack: false, on: true })).toBe(true);
  });

  it("lets Back go to the screen below", () => {
    expect(shouldAsk({ top: "library", canGoBack: true, on: true })).toBe(false);
  });

  it("doesn't ask elsewhere (sign-in, unlock, a share) or when turned off", () => {
    for (const top of ["signin", "unlock", "share", "server", undefined]) expect(shouldAsk({ top, canGoBack: false, on: true })).toBe(false);
    expect(shouldAsk({ top: "library", canGoBack: false, on: false })).toBe(false);
  });
});
