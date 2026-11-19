// The year in review as a story: the order of its pages (the same as the web and Android apps).
import Foundation
import Testing
@testable import CipherfilmCore

private let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
private func ms(_ y: Int, _ m: Int, _ d: Int) -> Double {
  cal.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!.timeIntervalSince1970 * 1000
}
private func item(_ id: String, favorite: Bool = false) -> Item {
  Item(id: id, kind: .image, size: 1, segmentCount: 1, createdAt: 0, hasThumb: true, hasPreview: true, favorite: favorite,
       trashedAt: nil, purgeAt: nil, meta: nil, itemKey: nil, broken: false)
}

@Suite struct RecapStoryTests {
  @Test func coverMonthsTripsPlacesPeopleEnd() {
    let trips = [
      (key: "short-may", start: ms(2024, 5, 3), count: 4),
      (key: "long-march", start: ms(2024, 3, 10), count: 40),
      (key: "mid-may", start: ms(2024, 5, 20), count: 12),
      (key: "longest-may", start: ms(2024, 5, 1), count: 60),
    ]
    let s = Recaps.slides(year: 2024, months: [5, 1, 3, 8], trips: trips, places: true, people: true, calendar: cal)
    // at most three trips, the longest; each after the month it starts in, by start
    #expect(s == [.cover, .month(1), .month(3), .trip("long-march"), .month(5), .trip("longest-may"), .trip("mid-may"), .month(8), .places, .people, .end])
  }

  @Test func tripFromTheYearBeforeAndQuietMonths() {
    let trips = [
      (key: "new-year", start: ms(2023, 12, 28), count: 9),
      (key: "april", start: ms(2024, 4, 2), count: 5),
    ]
    // no January photos: the trip that began the year before follows the first month; an April trip with no April
    // photos follows March
    let s = Recaps.slides(year: 2024, months: [2, 3, 6], trips: trips, places: false, people: false, calendar: cal)
    #expect(s == [.cover, .month(2), .trip("new-year"), .month(3), .trip("april"), .month(6), .end])
  }

  @Test func noTripsNoPlacesNoPeople() {
    #expect(Recaps.slides(year: 2024, months: [7], trips: [], places: false, people: false, calendar: cal) == [.cover, .month(7), .end])
    #expect(Recaps.slides(year: 2024, months: [7], trips: [], places: false, people: true, calendar: cal) == [.cover, .month(7), .people, .end])
  }

  @Test func monthPhotosStartWithTheBest() {
    let a = item("a"), b = item("b"), c = item("c", favorite: true), d = item("d")
    #expect(Recaps.storyPhotos(Recap.Month(month: 1, total: 9, highlights: [a, b, c, d])).map(\.id) == ["c", "a", "b", "d"])
    // no favorite: the middle one
    #expect(Recaps.storyPhotos(Recap.Month(month: 1, total: 9, highlights: [a, b, d])).map(\.id) == ["b", "a", "d"])
    #expect(Recaps.storyPhotos(Recap.Month(month: 1, total: 1, highlights: [])).isEmpty)
  }
}
