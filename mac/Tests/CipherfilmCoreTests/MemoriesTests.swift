// "On this day": the same cases as web/src/memories/memories.test.ts, so the Mac picks the same photos as the
// web and Android apps.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct MemoriesTests {
  static func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12, kind: Kind = .image, name: String? = nil, thumb: Bool = true, trashed: Bool = false, broken: Bool = false, ms: Double? = nil) -> Item {
    let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let ts = ms ?? Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h))!.timeIntervalSince1970 * 1000
    return Item(id: id, kind: kind, size: 1, segmentCount: 1, createdAt: 0, hasThumb: thumb, hasPreview: true, favorite: false,
                trashedAt: trashed ? 1 : nil, purgeAt: nil, meta: ItemMeta(name: name ?? "IMG_\(id.prefix(4)).jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: ts),
                itemKey: nil, broken: broken)
  }
  static func day(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 9) -> Date { Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h))! }
  let now = day(2026, 11, 11)

  @Test func groupsEarlierYearsNewestFirst() {
    let items = [Self.at(2023, 11, 11), Self.at(2023, 11, 12), Self.at(2020, 11, 10), Self.at(2025, 11, 11), Self.at(2024, 6, 1)]
    let m = Memories.find(items, now: now)
    #expect(m.map(\.year) == [2025, 2023, 2020])
    #expect(m.map(\.yearsAgo) == [1, 3, 6])
    #expect(m.map(\.items.count) == [1, 2, 1])
  }

  @Test func emptyAndNeverThisYear() {
    #expect(Memories.find([], now: now).isEmpty)
    #expect(Memories.find([Self.at(2026, 11, 11), Self.at(2026, 11, 9), Self.at(2024, 1, 1)], now: now).isEmpty)
  }

  @Test func windowOfThreeDays() {
    #expect(Memories.windowDays == 3)
    let inside = [Self.at(2022, 11, 8, 0), Self.at(2022, 11, 14, 23)]
    let outside = [Self.at(2022, 11, 7, 23), Self.at(2022, 11, 15, 0)]
    let m = Memories.find(inside + outside, now: now)
    #expect(m.count == 1)
    #expect(m[0].items.map(\.id) == inside.map(\.id))
    #expect(Memories.find([Self.at(2022, 11, 13)], now: now, window: 1).isEmpty)
  }

  @Test func leavesOutTrashedBrokenAndOther() {
    let m = Memories.find([Self.at(2021, 11, 11, trashed: true), Self.at(2021, 11, 11, broken: true), Self.at(2021, 11, 11, kind: .other)], now: now)
    #expect(m.isEmpty)
  }

  @Test func newYear() {
    let items = [Self.at(2024, 1, 2), Self.at(2023, 12, 30), Self.at(2025, 12, 31)]
    let m = Memories.find(items, now: Self.day(2026, 1, 1, 10))
    #expect(m.map(\.year) == [2024])
    #expect(m[0].items.map(\.id) == [items[1].id, items[0].id])
    #expect(m[0].yearsAgo == 2)
  }

  @Test func leapDay() {
    let leap = Self.at(2024, 2, 29)
    #expect(Memories.find([leap], now: Self.day(2025, 2, 28)).map(\.year) == [2024])
    let m = Memories.find([leap, Self.at(2027, 3, 1), Self.at(2027, 3, 4)], now: Self.day(2028, 2, 29, 8))
    #expect(m.map(\.year) == [2027, 2024])
    #expect(m.map(\.items.count) == [1, 1])
    #expect(Memories.find([leap], now: Self.day(2025, 3, 1)).map(\.year) == [2024])
  }

  @Test func otherTimeZonesUseTheirOwnDay() {
    // 10 Nov 2023 23:30 in UTC is 11 Nov in Zurich: the local day decides, as in the timeline
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    var zurich = Calendar(identifier: .gregorian); zurich.timeZone = TimeZone(identifier: "Europe/Zurich")!
    let ts = utc.date(from: DateComponents(year: 2023, month: 11, day: 10, hour: 23, minute: 30))!.timeIntervalSince1970 * 1000
    let it = Self.at(0, 0, 0, ms: ts)
    let today = zurich.date(from: DateComponents(year: 2026, month: 11, day: 14, hour: 12))!
    #expect(Memories.find([it], now: today, calendar: zurich).count == 1) // 11 Nov is 3 days before the 14th
    #expect(Memories.find([it], now: today, calendar: utc).isEmpty) // 10 Nov is 4 days before
  }

  @Test func capsAndSamples() {
    let base = Self.day(2020, 11, 11, 0).timeIntervalSince1970 * 1000
    let many = (0..<1000).map { i in Self.at(0, 0, 0, ms: base + Double(i) * 60_000) }
    let m = Memories.find(many, now: now)[0]
    #expect(m.total == 1000)
    #expect(m.items.count == Memories.maxPerYear)
    #expect(m.items.first?.id == many.first?.id)
    #expect(m.items.last?.id == many.last?.id)
    #expect(Set(m.items.map(\.id)).count == Memories.maxPerYear)
  }

  @Test func coverPrefersMiddleImageNotScreenshot() {
    let v1 = Self.at(2020, 1, 1, 1, kind: .video), i1 = Self.at(2020, 1, 1, 2), i2 = Self.at(2020, 1, 1, 3), i3 = Self.at(2020, 1, 1, 4), v2 = Self.at(2020, 1, 1, 5, kind: .video)
    #expect(Memories.cover([v1, i1, i2, i3, v2])?.id == i2.id)
    let shot = Self.at(2020, 1, 1, 1, name: "Screenshot_20200101.png")
    #expect(Memories.cover([shot, i1])?.id == i1.id)
    #expect(Memories.cover([shot, v1])?.id == shot.id)
    let noThumb = Self.at(2020, 1, 1, 1, thumb: false)
    #expect(Memories.cover([noThumb, v1])?.id == v1.id)
    #expect(Memories.cover([noThumb])?.id == noThumb.id)
    let a = Self.at(2023, 11, 9), b = Self.at(2023, 11, 10), c = Self.at(2023, 11, 13)
    #expect(Memories.find([c, a, b], now: now)[0].cover.id == b.id)
  }

  @Test func helpers() {
    for s in ["Screenshot_20231111-101010.png", "Screen Shot 2019-01-01 at 10.00.00.png", "Bildschirmfoto 2023-11-11 um 10.00.00.png", "Screen_Recording_2023.mp4"] { #expect(Memories.looksLikeScreenshot(s)) }
    for s in ["IMG_1234.JPG", "PXL_20231111_101010.jpg", "DSC0001.jpg"] { #expect(!Memories.looksLikeScreenshot(s)) }
    #expect(Memories.sample([1, 2, 3], 5) == [1, 2, 3])
    #expect(Memories.sample(Array(0..<10), 4) == [0, 3, 6, 9])
    #expect(Memories.yearsAgo(1) == "1 year ago")
    #expect(Memories.yearsAgo(4) == "4 years ago")
  }
}
