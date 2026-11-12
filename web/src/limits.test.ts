import { describe, expect, it } from "vitest";
import { gbBytes, gbText, uptimeText } from "./limits";

describe("storage limits in GB", () => {
  it("shows one decimal, not a rounded whole number", () => {
    expect(gbText(21.5e9)).toBe("21.5");
    expect(gbText(20e9)).toBe("20");
    expect(gbText(0)).toBe("0");
    expect(gbText(21.54e9)).toBe("21.5");
    expect(gbText(1e7)).toBe("0.1");
  });
  it("saving the field unchanged keeps the exact limit", () => {
    expect(gbBytes("21.5", 21.5e9)).toBe(21.5e9);
    expect(gbBytes("21.5", 21.54e9)).toBe(21.54e9);
    expect(gbBytes(" 20 ", 20e9)).toBe(20e9);
  });
  it("accepts decimals, with a point or a comma", () => {
    expect(gbBytes("2.5")).toBe(2.5e9);
    expect(gbBytes("2,5")).toBe(2.5e9);
    expect(gbBytes("0")).toBe(0);
    expect(gbBytes("21.6", 21.54e9)).toBe(21.6e9);
  });
  it("refuses what isn't a number of GB", () => {
    for (const t of ["", "-1", "abc", "1e3", "1.2.3", "."]) expect(gbBytes(t)).toBeNull();
  });
});

describe("uptime", () => {
  it("says one and many correctly", () => {
    expect(uptimeText(60)).toBe("1 minute");
    expect(uptimeText(30)).toBe("less than a minute");
    expect(uptimeText(5 * 60)).toBe("5 minutes");
    expect(uptimeText(3600)).toBe("1 hour");
    expect(uptimeText(2 * 3600 + 5)).toBe("2 hours");
    expect(uptimeText(86400)).toBe("1 day");
    expect(uptimeText(3 * 86400)).toBe("3 days");
  });
});
