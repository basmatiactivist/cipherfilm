// Close matches of a search by content (docs/SEARCH.md): the Mac's port runs the cases the web and Android apps run
// (web/src/search/matches.json, also read by web/src/search/matches.test.ts and mobile/src/search/matches.test.ts)
// with the same numbers.
import Foundation
import Testing
@testable import CipherfilmCore

private struct Cases: Decodable {
  struct Case: Decodable { let name: String; let scores: [Double]; let close: Int }
  let min: Double
  let gap: Double
  let floor: Double
  let few: Int
  let cases: [Case]
}

private let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../web/src/search/matches.json").standardized
private let all: Cases = try! JSONDecoder().decode(Cases.self, from: Data(contentsOf: file))

@Suite struct MatchesTests {
  @Test func sameNumbersAsTheOtherApps() {
    #expect(Matches.minScore == all.min)
    #expect(Matches.gap == all.gap)
    #expect(Matches.floor == all.floor)
    #expect(Matches.few == all.few)
  }

  @Test func everyCase() {
    #expect(all.cases.count >= 10)
    for c in all.cases { #expect(Matches.close(c.scores) == c.close, "\(c.name)") }
  }
}
