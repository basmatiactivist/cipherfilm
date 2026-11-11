// The explicit-content filter of search (docs/SEARCH.md, "Explicit content"), a port of web/src/search/explicit.ts: an
// image vector, or a query's text vector, is compared with the text vectors of fixed explicit and neutral concepts made
// once by scripts/explicit-filter.py (ExplicitConcepts.swift, the same numbers as server/explicit-filter.json; a test
// compares them). No model runs for it, nothing is stored or sent: it works on the vectors already here, also on
// entries made before it existed, and a later release can change the threshold without indexing again.
import Foundation

public enum Explicit {
  public static let imageThreshold = ExplicitConcepts.imageThreshold
  public static let queryThreshold = ExplicitConcepts.queryThreshold

  struct Concept { let explicit: Bool; let image: Bool; let v: [Float] }

  static let concepts: [Concept] = ExplicitConcepts.all.compactMap { c in
    guard let d = try? B64.decode(c.vec) else { return nil }
    return Concept(explicit: c.explicit, image: c.image, v: Vision.normalize(Vision.unhalf(d)))
  }

  /** Whether search shows explicit photos: only where an admin allowed explicit search for the person (`user.nsfw`) and
   *  they chose it (the people document's `explicit`, for all their devices). Everything else filters. */
  public static func unfiltered(allowed: Bool, chosen: Bool) -> Bool { allowed && chosen }

  /** How much more the vector looks like the closest explicit concept than like the closest neutral one (cosine);
   *  image: only the concepts worded as captions (an image vector), otherwise all (search words). NaN for a vector of
   *  another length. */
  public static func score(_ v: [Float], image: Bool) -> Float {
    guard let first = concepts.first, v.count == first.v.count else { return .nan }
    var n: Float = 0
    for x in v { n += x * x }
    n = n.squareRoot()
    if n == 0 { n = 1 }
    var e = -Float.infinity, o = -Float.infinity
    for c in concepts where !image || c.image {
      var d: Float = 0
      for i in 0..<v.count { d += v[i] * c.v[i] }
      d /= n
      if c.explicit { e = max(e, d) } else { o = max(o, d) }
    }
    return e - o
  }

  /** A photo kept out of filtered search results. */
  public static func imageHidden(_ v: [Float]) -> Bool { score(v, image: true) >= imageThreshold }
  /** Search words that find nothing in filtered search. */
  public static func queryBlocked(_ q: [Float]) -> Bool { score(q, image: false) >= queryThreshold }
}
