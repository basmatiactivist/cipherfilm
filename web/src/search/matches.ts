// Which photos a search by what is in them really finds (docs/SEARCH.md "Close matches"), shared by the web and the
// Android app (@websearch/matches); the Mac has a port (CipherfilmCore/Matches.swift) that runs the same cases.
// The image model ranks every photo; only the ones that score close to what the words describe count as results, the
// rest are "More similar photos". Filters, names and text in photos are exact and never cut.
import M from "./matches.json";

/** The numbers, for LAION's ViT-B/32 cosines (matches.json; measured in docs/SEARCH.md). */
export const MATCH = { min: M.min, gap: M.gap, floor: M.floor, few: M.few } as const;

/** How many of the ranked scores (best first) are close matches: those at least max(min, best - gap); when none is
 *  but the best reaches floor, the best few (within gap of the best). 0: no close matches. */
export function closeMatches(scores: readonly number[]): number {
  if (!scores.length) return 0;
  const best = scores[0];
  const cut = Math.max(MATCH.min, best - MATCH.gap);
  let n = 0;
  while (n < scores.length && scores[n] >= cut) n++;
  if (n === 0 && best >= MATCH.floor) while (n < scores.length && n < MATCH.few && scores[n] >= best - MATCH.gap) n++;
  return n;
}
