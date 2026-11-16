// Which photos a search by what is in them really finds (docs/SEARCH.md "Close matches"): a careful port of
// web/src/search/matches.ts, which the web and Android apps share. The numbers are those of web/src/search/matches.json
// and MatchesTests runs its cases, so every app cuts alike.

public enum Matches {
  /** a photo matches when its cosine is at least max(minScore, best - gap) */
  public static let minScore = 0.21
  public static let gap = 0.05
  /** when none does but the best reaches this, the best few (within gap of the best) do */
  public static let floor = 0.2
  public static let few = 3

  /** How many of the ranked scores (best first) are close matches; the rest are "More similar photos". 0: no close
   *  matches. */
  public static func close(_ scores: [Double]) -> Int {
    guard let best = scores.first else { return 0 }
    let cut = max(minScore, best - gap)
    var n = 0
    while n < scores.count && scores[n] >= cut { n += 1 }
    if n == 0 && best >= floor {
      while n < scores.count && n < few && scores[n] >= best - gap { n += 1 }
    }
    return n
  }
}
