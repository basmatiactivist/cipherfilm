// Trips and the year recap on the Mac give the same answers as the web and Android apps: the shared fixture
// (web/src/memories/testdata/trips.json) and its expected trips and recap, checked by web/src/memories/trips.test.ts too.
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private let places: Places = try! Places(contentsOf: repo.appendingPathComponent("web/src/places/places-v1.bin"))
nonisolated(unsafe) private let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("web/src/memories/testdata/trips.json"))) as! [String: Any]
nonisolated(unsafe) private let expected = fixture["expected"] as! [String: Any]

private func items() -> [Item] {
  (fixture["items"] as! [[String: Any]]).map { x in
    let m = x["meta"] as? [String: Any]
    let gps = (m?["gps"] as? [String: Double]).map { GPS(lat: $0["lat"]!, lon: $0["lon"]!) }
    let meta = m.map { ItemMeta(name: $0["name"] as! String, mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: ($0["capture_ts"] as! NSNumber).doubleValue, gps: gps) }
    return Item(id: x["id"] as! String, kind: Kind(rawValue: x["kind"] as! String)!, size: 1, segmentCount: 1, createdAt: (x["created_at"] as! NSNumber).doubleValue,
                hasThumb: x["has_thumb"] as? Bool ?? true, hasPreview: true, favorite: x["favorite"] as? Bool ?? false,
                trashedAt: (x["trashed_at"] as? NSNumber)?.doubleValue, purgeAt: nil, meta: meta, itemKey: nil,
                // no locked folder on the Mac yet: a locked item (meta.locked) stands in as one that never counts
                broken: (x["broken"] as? Bool ?? false) || (m?["locked"] as? Bool ?? false))
  }
}

private func json(_ w: Where) -> [String: AnyHashable] {
  switch w {
  case let .place(n, c, k): return ["kind": "place", "name": n, "country": c, "countryCode": k]
  case let .region(n, c, k): return ["kind": "region", "name": n, "country": c, "countryCode": k]
  case let .country(c, k): return ["kind": "country", "country": c, "countryCode": k]
  case let .countries(l): return ["kind": "countries", "countries": l.map { ["country": $0.country, "countryCode": $0.countryCode] as [String: String] }]
  case .none: return ["kind": "none"]
  }
}

private let lookup: Trips.Lookup = { places.nearest($0, $1) }

@Suite struct TripsTests {
  @Test func findsTheSameTripsAsTheOtherApps() {
    let got = Trips.find(items(), lookup: lookup)
    let want = expected["trips"] as! [[String: Any]]
    #expect(got.count == want.count)
    for (t, w) in zip(got, want) {
      #expect(t.key == w["key"] as! String)
      #expect(t.days == w["days"] as! Int)
      #expect(t.items.map(\.id) == w["items"] as! [String])
      #expect(json(t.place) == (w["where"] as! [String: Any]).mapValues { v -> AnyHashable in
        (v as? [[String: String]]).map { $0 as AnyHashable } ?? (v as! String) as AnyHashable
      })
    }
  }

  @Test func makesTheSameYearRecap() {
    let people = (expected["people"] as! [[String: Any]]).map { (key: $0["key"] as! String, items: $0["items"] as! [String]) }
    let r = Recaps.recap(items(), year: 2025, lookup: lookup, people: people)!
    let w = expected["recap"] as! [String: Any]
    #expect(r.photos == w["photos"] as! Int)
    #expect(r.videos == w["videos"] as! Int)
    #expect(r.days == w["days"] as! Int)
    #expect(r.countries == w["countries"] as! Int)
    #expect(r.cover.id == w["cover"] as! String)
    #expect(r.people.map(\.key) == (w["people"] as! [[String: Any]]).map { $0["key"] as! String })
    #expect(r.people.map(\.count) == (w["people"] as! [[String: Any]]).map { $0["count"] as! Int })
    let wp = w["places"] as! [[String: Any]]
    #expect(r.places.map(\.name) == wp.map { $0["name"] as! String })
    #expect(r.places.map(\.count) == wp.map { $0["count"] as! Int })
    #expect(r.places.map(\.cover.id) == wp.map { $0["cover"] as! String })
    let wm = w["months"] as! [[String: Any]]
    #expect(r.months.map { $0.month - 1 } == wm.map { $0["month"] as! Int })
    #expect(r.months.map(\.total) == wm.map { $0["total"] as! Int })
    #expect(r.months.map { $0.highlights.map(\.id) } == wm.map { $0["highlights"] as! [String] })
  }

  @Test func offersTheSameYears() {
    let ys = expected["years"] as! [String: [Int]]
    let d = { (y: Int, m: Int, dd: Int) in Calendar.current.date(from: DateComponents(year: y, month: m, day: dd, hour: 12))! }
    #expect(Recaps.years(items(), now: d(2026, 11, 16)) == ys["2026-11-16"]!)
    #expect(Recaps.years(items(), now: d(2026, 12, 2)) == ys["2026-12-02"]!)
  }

  @Test func readsTheMonthsAndPlaces() {
    let d = { (y: Int, m: Int, dd: Int) in Calendar.current.date(from: DateComponents(year: y, month: m, day: dd, hour: 12))!.timeIntervalSince1970 * 1000 }
    #expect(Trips.dates(d(2026, 5, 3), d(2026, 5, 9)) == "May 2026")
    #expect(Trips.dates(d(2026, 5, 30), d(2026, 6, 2)) == "May – June 2026")
    #expect(Trips.dates(d(2025, 12, 30), d(2026, 1, 2)) == "December 2025 – January 2026")
    #expect(Trips.text(.countries([("Italy", "IT"), ("France", "FR")])) == "Italy and France")
    #expect(Trips.text(.countries([("Italy", "IT"), ("France", "FR"), ("Spain", "ES"), ("Monaco", "MC")])) == "Italy, France and 2 more")
  }
}
