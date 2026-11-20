// Custom reviews on the Mac give the same answers as the web and Android apps: the shared fixture
// (web/src/memories/testdata/custom.json, checked by web/src/memories/custom.test.ts too) and the main behaviours of
// that test file.
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
nonisolated(unsafe) private let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("web/src/memories/testdata/custom.json"))) as! [String: Any]

private typealias C = CustomReviews

private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12) -> Date {
  Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h))!
}
private func review(id: String = "r1", name: String = "Dogs", query: String = "dog", every: Review.Every = .day, count: Int = 6) -> Review {
  Review(id: id, name: name, query: query, every: every, count: count, notify: true, created: 1, updated: 1)
}
private func item(_ id: String, _ y: Int, _ m: Int, _ d: Int = 15, kind: Kind = .image, favorite: Bool = false, name: String = "x.jpg",
                  hasThumb: Bool = true, broken: Bool = false, trashed: Bool = false, locked: Bool = false) -> Item {
  var meta = ItemMeta(name: name, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: at(y, m, d).timeIntervalSince1970 * 1000)
  if locked { meta.locked = JSONTrue(true) }
  return Item(id: id, kind: kind, size: 1, segmentCount: 1, createdAt: 0, hasThumb: hasThumb, hasPreview: true, favorite: favorite,
              trashedAt: trashed ? 5 : nil, purgeAt: nil, meta: meta, itemKey: nil, broken: broken)
}
private func ids(_ xs: [Item]) -> [String] { xs.map(\.id) }
private func num(_ x: Any?) -> Int { (x as! NSNumber).intValue }

@Suite struct CustomReviewTests {
  // ---- the shared fixture ----

  @Test func fixturePeriods() {
    for c in fixture["periods"] as! [[String: Any]] {
      let every = Review.Every(rawValue: c["every"] as! String)!
      #expect(C.periodOf(every, at(num(c["y"]), num(c["m"]), num(c["d"]), num(c["h"]))) == num(c["period"]), "\(c)")
    }
  }

  @Test func fixtureSeedsAndRandomNumbers() {
    for c in fixture["seeds"] as! [[String: Any]] {
      #expect(C.seedOf(c["id"] as! String, num(c["period"])) == UInt32((c["seed"] as! NSNumber).int64Value))
    }
    let random = fixture["random"] as! [String: Any]
    var r = C.Mulberry32(UInt32((random["seed"] as! NSNumber).int64Value))
    let want = (random["values"] as! [NSNumber]).map(\.int64Value)
    #expect(want.map { _ in Int64((r.next() * 1e9).rounded()) } == want)
  }

  @Test func fixturePicks() {
    for c in fixture["picks"] as! [[String: Any]] {
      let items = (c["items"] as! [[String: Any]]).map { x in
        item(x["id"] as! String, num(x["y"]), num(x["m"]), num(x["d"]), kind: Kind(rawValue: x["kind"] as? String ?? "image")!,
             favorite: x["favorite"] as? Bool ?? false, name: x["name"] as? String ?? "")
      }
      let got = C.pickReview(items, count: num(c["count"]), shown: c["shown"] as! [String], seed: UInt32((c["seed"] as! NSNumber).int64Value))
      #expect(ids(got) == c["want"] as! [String], "\(c["name"]!)")
    }
  }

  // ---- periods ----

  @Test func aDayAWeekFromMondayACalendarMonth() {
    #expect(C.periodOf(.day, at(1970, 1, 1)) == 0)
    #expect(C.periodOf(.day, at(1970, 1, 2, 0)) == 1)
    #expect(C.periodOf(.week, at(1969, 12, 29)) == 0)
    #expect(C.periodOf(.week, at(1970, 1, 4, 23)) == 0)
    #expect(C.periodOf(.week, at(1970, 1, 5, 0)) == 1)
    #expect(C.periodOf(.month, at(1970, 1, 31)) == 0)
    #expect(C.periodOf(.month, at(2026, 11, 20)) == 56 * 12 + 10)
  }

  @Test func aClockChangeDoesntSkipOrRepeatADay() {
    let days = [25, 26, 27, 28, 29, 30, 31].map { C.periodOf(.day, at(2026, 3, $0, 0)) }
    #expect(zip(days.dropFirst(), days).map { $0 - $1 } == [1, 1, 1, 1, 1, 1])
    let oct = [24, 25, 26].map { C.periodOf(.day, at(2026, 10, $0, 23)) }
    #expect(oct == [oct[0], oct[0] + 1, oct[0] + 2])
  }

  @Test func dueOncePerPeriod() {
    let r = review(every: .week)
    let now = at(2026, 11, 20)
    #expect(C.isDue(r, ReviewDoc(), now: now))
    let seen = C.recordShown(ReviewDoc(), id: r.id, period: C.periodOf(.week, now), ids: ["a"])
    #expect(!C.isDue(r, seen, now: now))
    #expect(C.isDue(r, seen, now: at(2026, 11, 23, 0)))
    #expect(C.nextDue(r, seen, now: now) == at(2026, 11, 23, 0))
    var m = r; m.every = .month
    #expect(C.nextDue(m, C.recordShown(ReviewDoc(), id: r.id, period: C.periodOf(.month, now), ids: []), now: now) == at(2026, 12, 1, 0))
    var d = r; d.every = .day
    #expect(C.nextDue(d, C.recordShown(ReviewDoc(), id: r.id, period: C.periodOf(.day, now), ids: []), now: now) == at(2026, 11, 21, 0))
    #expect(C.nextDue(r, ReviewDoc(), now: now) == now)
  }

  // ---- picking ----

  private let lib = (0..<40).map { i in item(String(format: "i%02d", i), 2020 + i % 5, 1 + i % 12, 1 + i % 27) }

  @Test func sameSeedSameStory() {
    #expect(ids(C.pickReview(lib, count: 6, shown: [], seed: 1)) == ids(C.pickReview(lib, count: 6, shown: [], seed: 1)))
    #expect(ids(C.pickReview(lib, count: 6, shown: [], seed: 1)) != ids(C.pickReview(lib, count: 6, shown: [], seed: 2)))
  }

  @Test func inCaptureOrderNoPhotoTwice() {
    let p = C.pickReview(lib + lib, count: 12, shown: [], seed: 7)
    #expect(Set(ids(p)).count == 12)
    #expect(p.map(\.when) == p.map(\.when).sorted())
  }

  @Test func fewerMatchesThanCount() {
    #expect(ids(C.pickReview(Array(lib.prefix(3)), count: 12, shown: [], seed: 1)).sorted() == ["i00", "i01", "i02"])
    #expect(C.pickReview([], count: 6, shown: [], seed: 1).isEmpty)
  }

  @Test func photosShownLatelyWait() {
    var doc = ReviewDoc()
    var seen = Set<String>()
    for period in 0..<6 {
      let p = C.pickReview(lib, count: 6, shown: doc.shown["r1"]?.ids ?? [], seed: C.seedOf("r1", period))
      for x in p { #expect(!seen.contains(x.id)); seen.insert(x.id) }
      doc = C.recordShown(doc, id: "r1", period: period, ids: ids(p))
    }
    #expect(seen.count == 36)
    let seventh = ids(C.pickReview(lib, count: 6, shown: doc.shown["r1"]!.ids, seed: C.seedOf("r1", 6)))
    let never = ids(lib).filter { !seen.contains($0) }
    #expect(never.allSatisfy(seventh.contains))
    let oldest = Array(doc.shown["r1"]!.ids.prefix(6))
    #expect(seventh.filter { !never.contains($0) }.allSatisfy(oldest.contains))
  }

  @Test func historyOfGonePhotosDoesntMatter() {
    #expect(C.pickReview(Array(lib.prefix(8)), count: 6, shown: ["gone1", "gone2", "i00"], seed: 3).count == 6)
  }

  @Test func spreadOverTheMonths() {
    let busy = (0..<30).map { item("b\($0)", 2024, 7, 1 + $0 % 28) } + [item("x1", 2021, 3), item("x2", 2022, 5), item("x3", 2023, 9)]
    let p = ids(C.pickReview(busy, count: 6, shown: [], seed: 11))
    #expect(["x1", "x2", "x3"].allSatisfy(p.contains))
  }

  @Test func screenshotsAndVideosLast() {
    let m = [item("shot", 2024, 1, 2, name: "Screenshot_2024.png"), item("vid", 2024, 1, 3, kind: .video), item("pic", 2024, 1, 4), item("v2", 2024, 2, 4, kind: .video)]
    #expect(ids(C.pickReview(m, count: 2, shown: [], seed: 5)) == ["pic", "v2"])
  }

  @Test func nothingWithoutThumbnailBrokenTrashedOrLocked() {
    let bad = [item("a", 2024, 1, 1, hasThumb: false), item("b", 2024, 1, 1, broken: true), item("c", 2024, 1, 1, trashed: true),
               item("d", 2024, 1, 1, locked: true), item("ok", 2024, 1, 1)]
    #expect(ids(C.pickReview(bad, count: 6, shown: [], seed: 1)) == ["ok"])
  }

  // ---- the document ----

  @Test func theSamePeriodPlaysWhatItPlayed() {
    let lib = [item("a", 2020, 1), item("b", 2021, 1), item("c", 2022, 1)]
    let doc = C.recordShown(ReviewDoc(), id: "r1", period: 5, ids: ["c", "a"])
    #expect(C.replayed(doc, id: "r1", period: 5, matches: lib).map(ids) == ["a", "c"])
    #expect(C.replayed(doc, id: "r1", period: 6, matches: lib) == nil)
    #expect(C.replayed(C.recordShown(ReviewDoc(), id: "r1", period: 5, ids: ["gone"]), id: "r1", period: 5, matches: lib) == nil)
  }

  @Test func historyNewestLastTrimmed() {
    var d = C.recordShown(ReviewDoc(), id: "r1", period: 1, ids: ["a", "b"])
    d = C.recordShown(d, id: "r1", period: 2, ids: ["c", "a"])
    #expect(d.shown["r1"] == ReviewShown(period: 2, ids: ["b", "c", "a"], now: ["c", "a"]))
    d = C.recordShown(d, id: "r1", period: 3, ids: (0..<(C.maxShown + 5)).map { "x\($0)" })
    #expect(d.shown["r1"]!.ids.count == C.maxShown)
    #expect(d.shown["r1"]!.ids.last == "x\(C.maxShown + 4)")
  }

  @Test func addingAndEditingCleanTheInputADeletedReviewStaysDeleted() throws {
    var d = try C.upsertReview(ReviewDoc(), review(name: "  ", query: "  dogs at the beach  ", count: 7), now: 10)
    #expect(d.reviews[0].name == "dogs at the beach")
    #expect(d.reviews[0].query == "dogs at the beach")
    #expect(d.reviews[0].count == 6)
    #expect(d.reviews[0].updated == 10)
    var e = d.reviews[0]; e.name = "Beach dogs"; e.count = 30
    d = try C.upsertReview(d, e, now: 11)
    #expect(d.reviews.count == 1)
    #expect(d.reviews[0].name == "Beach dogs" && d.reviews[0].count == 30 && d.reviews[0].updated == 11)
    d = C.recordShown(d, id: "r1", period: 1, ids: ["a"])
    d = C.deleteReview(d, id: "r1", now: 12)
    #expect(d.reviews.isEmpty)
    #expect(d.shown["r1"] == nil)
    #expect(d.deleted["r1"] == 12)
    #expect(try C.upsertReview(d, review(), now: 13).reviews.isEmpty)
    #expect(throws: ReviewError.noQuery) { try C.upsertReview(ReviewDoc(), review(query: ""), now: 1) }
    #expect(C.counts == [6, 12, 20, 30])
  }

  @Test func changingHowOftenMakesItDueAtOnce() throws {
    let now = at(2026, 11, 20)
    var d = try C.upsertReview(ReviewDoc(), review(every: .day), now: 1)
    d = C.recordShown(d, id: "r1", period: C.periodOf(.day, now), ids: ["a", "b"])
    #expect(!C.isDue(d.reviews[0], d, now: now))
    var monthly = d.reviews[0]; monthly.every = .month
    d = try C.upsertReview(d, monthly, now: 2)
    #expect(C.isDue(d.reviews[0], d, now: now))
    #expect(d.shown["r1"] == ReviewShown(period: -1, ids: ["a", "b"], now: []))
    var renamed = d.reviews[0]; renamed.name = "x"
    let e = try C.upsertReview(C.recordShown(d, id: "r1", period: C.periodOf(.month, now), ids: ["c"]), renamed, now: 3)
    #expect(!C.isDue(e.reviews[0], e, now: now))
  }

  @Test func atMostMaxReviews() throws {
    var d = ReviewDoc()
    for i in 0..<C.maxReviews { d = try C.upsertReview(d, review(id: "r\(i)"), now: 1) }
    #expect(throws: ReviewError.tooMany) { try C.upsertReview(d, review(id: "one more"), now: 1) }
  }

  @Test func tidyDropsOldMarkersAndOrphanHistory() {
    var d = ReviewDoc()
    d.deleted = ["old": 0, "fresh": 95 * 86_400_000]
    d.shown = ["nobody": ReviewShown(period: 1, ids: ["a"], now: ["a"])]
    let t = C.tidy(d, now: 100 * 86_400_000)
    #expect(t.deleted == ["fresh": 95 * 86_400_000])
    #expect(t.shown.isEmpty)
  }

  @Test func aDamagedOrNewerDocumentDoesntBreakTheApp() throws {
    #expect(C.readDoc(Data("null".utf8)) == ReviewDoc())
    #expect(C.readDoc(Data("not json".utf8)) == ReviewDoc())
    let damaged = #"{"v":1,"reviews":[{"id":"x"},{"id":"r1","name":"Dogs","query":"dog","every":"day","count":6,"notify":true,"created":1,"updated":1}],"shown":{"r1":{"period":"x"}}}"#
    var want = ReviewDoc(); want.reviews = [review()]
    #expect(C.readDoc(Data(damaged.utf8)) == want)
    let newer = #"{"v":2,"reviews":[{"id":"r1","name":"Dogs","query":"dog","every":"day","count":6,"notify":true,"created":1,"updated":1,"color":"red"}],"shown":{},"deleted":{},"extra":1}"#
    let d = C.readDoc(Data(newer.utf8))
    #expect(d.reviews[0].extra["color"] == .string("red"))
    // kept when saved again, so an older app doesn't drop what a newer one added
    let again = try C.upsertReview(d, d.reviews[0], now: 5)
    let o = try JSONSerialization.jsonObject(with: C.encode(again)) as! [String: Any]
    #expect((o["reviews"] as! [[String: Any]])[0]["color"] as? String == "red")
  }

  @Test func theJSONHasTheSameKeysAsTheOtherApps() throws {
    var d = try C.upsertReview(ReviewDoc(), review(), now: 1_763_600_000_123)
    d = C.recordShown(d, id: "r1", period: 20777, ids: ["a"])
    d = C.deleteReview(try C.upsertReview(d, review(id: "r2"), now: 2), id: "r2", now: 3)
    let text = String(decoding: try C.encode(d), as: UTF8.self)
    #expect(text == #"{"deleted":{"r2":3},"reviews":[{"count":6,"created":1763600000123,"every":"day","id":"r1","name":"Dogs","notify":true,"query":"dog","updated":1763600000123}],"shown":{"r1":{"ids":["a"],"now":["a"],"period":20777}},"v":1}"#)
    #expect(C.readDoc(try C.encode(d)) == d)
  }

  // ---- slides ----

  @Test func coverYearsEnd() {
    let picked = [item("a", 2019, 1)] + (0..<8).map { item("b\($0)", 2021, 1 + $0) } + [item("c", 2023, 5, 1, favorite: true)]
    let s = C.slides(review(), picked: picked, total: 120)
    guard case let .rcover(cover, name, total, shown) = s[0] else { Issue.record("no cover"); return }
    #expect(cover.id == "c" && name == "Dogs" && total == 120 && shown == 10)
    let years = s.dropFirst().compactMap { x -> [Int]? in if case let .ryear(y, p) = x { return [y, p.count] }; return nil }
    #expect(years == [[2019, 1], [2021, 6], [2021, 2], [2023, 1]])
    #expect(s.count == 6 && s.last == .rend)
    #expect(C.slides(review(), picked: [], total: 0) == [.rend])
  }
}
