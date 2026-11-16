import { describe, expect, it } from "vitest";
import CASES from "./matches.json";
import { closeMatches, MATCH } from "./matches";

// The same cases run in the Android app's tests (mobile/src/search/matches.test.ts) and on the Mac (MatchesTests.swift).
describe("search by content: close matches", () => {
  it("uses the numbers of matches.json", () => expect(MATCH).toEqual({ min: 0.21, gap: 0.05, floor: 0.2, few: 3 }));
  for (const c of CASES.cases) it(c.name, () => expect(closeMatches(c.scores)).toBe(c.close));
});
