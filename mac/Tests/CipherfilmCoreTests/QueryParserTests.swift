// Combined search (docs/SEARCH.md): the Mac's port of the query parser runs the very cases the web and Android apps
// run (web/src/search/parse-cases.json, also read by web/src/search/parse.test.ts), so every app reads a query alike;
// the same for the text slot of an index entry and the German glossary.
import Foundation
import Testing
@testable import CipherfilmCore

private let web = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../web/src").standardized

private struct Cases: Decodable {
  struct Ctx: Decodable { let people: [String]; let places: [String: String]; let today: String }
  struct Case: Decodable {
    let q: String
    let people: [[String]]?
    let places: [String]?
    let dates: [QueryParser.When]?
    let favorites: Bool?
    let videos: Bool?
    let screenshots: Bool?
    let text: String
    let clip: String?
    let chips: [[Field]]
  }
  enum Field: Decodable, Equatable {
    case s(String), i(Int)
    init(from d: Decoder) throws {
      let c = try d.singleValueContainer()
      if let i = try? c.decode(Int.self) { self = .i(i) } else { self = .s(try c.decode(String.self)) }
    }
  }
  struct Remove: Decodable { let q: String; let chip: Int; let out: String }
  struct Text: Decodable { let text: String; let q: String; let match: String? }
  struct InWhen: Decodable { let when: QueryParser.When; let day: String; let `in`: Bool }
  struct Slot: Decodable { let `in`: String; let out: String }
  let context: Ctx
  let cases: [Case]
  let remove: [Remove]
  let text: [Text]
  let when: [InWhen]
  let slot: [Slot]
}

private let all: Cases = try! JSONDecoder().decode(Cases.self, from: Data(contentsOf: web.appendingPathComponent("search/parse-cases.json")))
private func ctx() -> QueryParser.Context { QueryParser.Context(people: all.context.people, place: { all.context.places[$0] }, today: all.context.today) }

@Suite struct QueryParserTests {
  @Test func everyCase() {
    #expect(all.cases.count > 40)
    for c in all.cases {
      let p = QueryParser.parse(c.q, ctx())
      #expect(p.people == (c.people ?? []), "\(c.q)")
      #expect(p.places == (c.places ?? []), "\(c.q)")
      #expect(p.dates == (c.dates ?? []), "\(c.q)")
      #expect(p.favorites == (c.favorites ?? false), "\(c.q)")
      #expect(p.videos == (c.videos ?? false), "\(c.q)")
      #expect(p.screenshots == (c.screenshots ?? false), "\(c.q)")
      #expect(p.text == c.text, "\(c.q)")
      #expect(p.clip == (c.clip ?? c.text), "\(c.q)")
      #expect(p.chips.map { [Cases.Field.s($0.kind.rawValue), .i($0.start), .i($0.end)] } == c.chips, "\(c.q)")
    }
  }

  @Test func removingAChip() {
    #expect(!all.remove.isEmpty)
    for r in all.remove { #expect(QueryParser.removeChip(r.q, QueryParser.parse(r.q, ctx()).chips[r.chip]) == r.out, "\(r.q) chip \(r.chip)") }
  }

  @Test func textInPhotos() {
    #expect(!all.text.isEmpty)
    for t in all.text { #expect(QueryParser.textMatch(t.text, t.q) == t.match, "\(t.q) in \(t.text)") }
  }

  @Test func dates() {
    #expect(!all.when.isEmpty)
    for w in all.when { #expect(QueryParser.inWhen(w.when, w.day) == w.in, "\(w.when) on \(w.day)") }
  }

  @Test func foldsAccentsCaseAndSharpS() {
    #expect(QueryParser.fold("Zürich STRAßE") == "zurich strasse")
    #expect(QueryParser.parse("anna rome", .init(people: [], today: "2026-01-01")).text == "anna rome")
  }

  @Test func localDay() {
    var c = DateComponents(); c.year = 2025; c.month = 5; c.day = 4; c.hour = 23; c.minute = 30
    let d = Calendar.current.date(from: c)!
    #expect(QueryParser.localDay(d.timeIntervalSince1970 * 1000) == "2025-05-04")
  }

  @Test func sameGlossaryAsTheWeb() throws {
    let j = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: web.appendingPathComponent("search/glossary-de.json")))
    #expect(QueryParser.glossary == j)
  }

  /** JavaScript's `in` on a plain object also sees its prototype ("constructor"): not taken over here. */
  @Test func wordsAreOnlyWords() {
    let p = QueryParser.parse("constructor toString", ctx())
    #expect(p.chips.isEmpty && p.text == "constructor tostring" && p.clip == "constructor tostring")
  }

  // ---- the text slot of an index entry (web/src/crypto/search.ts textSlot) ----

  @Test func textSlot() throws {
    #expect(!all.slot.isEmpty)
    for c in all.slot {
      let s = IndexEntry.textSlot(c.in)
      #expect(s.utf8.count == IndexEntry.textBytes, "\(c.in.prefix(30))")
      #expect(s.trimmingCharacters(in: .whitespaces) == c.out)
      // nothing in it needs escaping in JSON
      let enc = JSONEncoder(); enc.outputFormatting = [.withoutEscapingSlashes]
      #expect(try enc.encode([s]).count == s.utf8.count + 4)
    }
  }
}

@Suite struct QueryChipLabelTests {
  @Test func datesInWords() {
    typealias W = QueryParser.When
    #expect(QueryParser.whenLabel(W(from: "2025-01-01", to: "2025-12-31")) == "2025")
    #expect(QueryParser.whenLabel(W(from: "2019-01-01", to: "2021-12-31")) == "2019–2021")
    #expect(QueryParser.whenLabel(W(from: "2025-05-01", to: "2025-05-31")) == "May 2025")
    #expect(QueryParser.whenLabel(W(from: "2025-05-01", to: "2025-07-31")) == "May–July 2025")
    #expect(QueryParser.whenLabel(W(months: [5, 7])) == "June–August")
    #expect(QueryParser.whenLabel(W(months: [11, 11], days: [20, 27])) == "Christmas")
    #expect(QueryParser.whenLabel(W(from: "2023-12-20", to: "2023-12-27")) == "Christmas 2023")
    #expect(QueryParser.whenLabel(W(from: "2020-01-01")) == "Since 2020")
    #expect(QueryParser.whenLabel(W(to: "2019-12-31")) == "Until 2019")
    #expect(QueryParser.whenLabel(W(from: "2023-12-24", to: "2023-12-24")) == "Dec 24, 2023")
  }

  @Test func chipsInWords() {
    let p = QueryParser.parse("fotos von Anna aus Rom im Mai favorites", ctx())
    #expect(p.chips.map(QueryParser.label) == ["Anna Müller or Anna Schmidt", "Rome", "May", "Favorites"])
  }
}
