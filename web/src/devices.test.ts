import { describe, expect, it } from "vitest";
import { idleDaysOf, unusedButton, unusedDevices } from "./devices";

const now = 1_800_000_000;
const day = 86400;

describe("unused devices", () => {
  it("takes the account's choice, or 30 days", () => {
    expect(idleDaysOf(7)).toBe(7);
    expect(idleDaysOf(14)).toBe(14);
    expect(idleDaysOf(30)).toBe(30);
    expect(idleDaysOf(undefined)).toBe(30);
    expect(idleDaysOf(10)).toBe(30);
    expect(idleDaysOf("7")).toBe(30);
  });

  it("counts other devices unused for longer than the limit, never this one", () => {
    const list = [
      { id: "this", current: true, last_seen: now - 40 * day },
      { id: "a", current: false, last_seen: now - 8 * day },
      { id: "b", current: false, last_seen: now - 7 * day },
      { id: "c", current: false, last_seen: now - 20 * day },
    ];
    expect(unusedDevices(list, 7, now).map((d) => d.id)).toEqual(["a", "c"]);
    expect(unusedDevices(list, 14, now).map((d) => d.id)).toEqual(["c"]);
    expect(unusedDevices(list, 30, now)).toEqual([]);
  });

  it("names the button", () => {
    expect(unusedButton(1)).toBe("Sign out 1 unused device");
    expect(unusedButton(3)).toBe("Sign out 3 unused devices");
  });
});
