import { describe, expect, it } from "vitest";
import CASES from "@websearch/matches.json";
import { closeMatches, MATCH } from "@websearch/matches";

// Which photos a search by content finds (docs/SEARCH.md "Close matches"): the module the web app shares, with the
// cases the web (web/src/search/matches.test.ts) and the Mac (MatchesTests.swift) run too.
describe("search by content: close matches", () => {
  it("uses the numbers of matches.json", () => expect(MATCH).toEqual({ min: 0.21, gap: 0.05, floor: 0.2, few: 3 }));
  for (const c of CASES.cases) it(c.name, () => expect(closeMatches(c.scores)).toBe(c.close));
});
