import { describe, expect, it, vi } from "vitest";

vi.mock("expo-asset", () => ({ Asset: { fromModule: () => ({}) } }));
vi.mock("expo-file-system", () => ({ File: class {} }));

const { nameMatches } = await import("./places");

describe("search words against place names", () => {
  it("the whole name or one of its words", () => {
    expect(nameMatches("zurich", "zurich")).toBe(true);
    expect(nameMatches("new york city", "york")).toBe(true);
    expect(nameMatches("saint-tropez", "tropez")).toBe(true);
  });
  it("the start of a name or word from 4 letters on", () => {
    expect(nameMatches("switzerland", "switz")).toBe(true);
    expect(nameMatches("schweiz", "schw")).toBe(true);
  });
  it("short words only whole, so common words don't pull in towns", () => {
    expect(nameMatches("seefeld in tirol", "see")).toBe(false);
    expect(nameMatches("carouge", "car")).toBe(false);
    expect(nameMatches("bern", "ber")).toBe(false);
  });
});
