// The year recap: per year, how many photos and videos, the places and people seen most, and a few photos for each
// month. Worked out on this Mac; nothing about it goes to the server. The same rules as the web and Android apps
// (web/src/memories/recap.ts), checked against the same fixture (TripsTests).
import Foundation

public struct Recap: Sendable {
  public struct PlaceCount: Sendable, Identifiable { public var id: String { name + countryCode }; public let name: String; public let country: String; public let countryCode: String; public let count: Int; public let cover: Item }
  public struct PersonCount: Sendable, Identifiable { public var id: String { key }; public let key: String; public let count: Int }
  public struct Month: Sendable, Identifiable { public var id: Int { month }; /** 1 = January */ public let month: Int; public let total: Int; public let highlights: [Item] }
  public let year: Int
  public let photos: Int
  public let videos: Int
  /** different days with photos */
  public let days: Int
  public let places: [PlaceCount]
  public let countries: Int
  public let people: [PersonCount]
  public let months: [Month]
  public let cover: Item
}

public enum Recaps {
  /** Photos shown for each month; places and people listed. */
  public static let perMonth = 4
  public static let top = 5

  private static func older(_ a: Item, _ b: Item) -> Bool { a.when != b.when ? a.when < b.when : a.id < b.id }
  private static func usable(_ i: Item) -> Bool { i.kind == .image && i.hasThumb && !Memories.looksLikeScreenshot(i.name) }

  /** The years with a recap: every earlier year with photos, and this year from December on. Newest first. */
  public static func years(_ items: [Item], now: Date = Date(), calendar cal: Calendar = .current) -> [Int] {
    let ty = cal.component(.year, from: now)
    let last = cal.component(.month, from: now) == 12 ? ty : ty - 1
    var ys = Set<Int>()
    for it in items where Trips.counts(it) {
      let y = Trips.year(it.when, cal)
      if y <= last { ys.insert(y) }
    }
    return ys.sorted(by: >)
  }

  /** A month's highlights, oldest first: favorites first (spread over the month), then one photo from the middle of
   *  each day, spread over the days. */
  public static func highlights(_ list: [Item], _ n: Int = perMonth, calendar cal: Calendar = .current) -> [Item] {
    let sorted = list.sorted(by: older)
    var pool = sorted.filter(usable)
    if pool.isEmpty { pool = sorted.filter(\.hasThumb) }
    var picks = Memories.sample(pool.filter(\.favorite), n)
    let chosen = Set(picks.map(\.id))
    var order: [Int] = [], byDay: [Int: [Item]] = [:]
    for i in pool where !chosen.contains(i.id) {
      let d = Trips.day(i.when, cal)
      if byDay[d] == nil { order.append(d) }
      byDay[d, default: []].append(i)
    }
    let perDay = order.map { d -> Item in let l = byDay[d]!; return l[(l.count - 1) / 2] }
    picks += Memories.sample(perDay, n - picks.count)
    // a month whose photos are from fewer days than places: the rest of them, spread over the month
    if picks.count < n {
      let taken = Set(picks.map(\.id))
      picks += Memories.sample(pool.filter { !taken.contains($0.id) }, n - picks.count)
    }
    return picks.sorted(by: older)
  }

  /** The recap of one year, nil when it has no photos. `people` are the face groups to count (key and photo ids). */
  public static func recap(_ items: [Item], year: Int, lookup: Trips.Lookup? = nil, people: [(key: String, items: [String])] = [],
                           perMonth: Int = perMonth, calendar cal: Calendar = .current) -> Recap? {
    let list = items.filter { Trips.counts($0) && Trips.year($0.when, cal) == year }.sorted(by: older)
    guard !list.isEmpty else { return nil }
    var months: [Int: [Item]] = [:]
    for it in list { months[cal.component(.month, from: it.date), default: []].append(it) }

    struct P { let name: String; let country: String; let code: String; var items: [Item] }
    var placeCount: [String: P] = [:]
    var countries = Set<String>()
    if let f = lookup {
      for it in list {
        guard let g = Trips.gps(it), let h = f(g.lat, g.lon), !h.countryCode.isEmpty else { continue }
        countries.insert(h.countryCode)
        guard let p = h.place else { continue }
        let k = "\(p.name)\u{0}\(h.countryCode)"
        placeCount[k, default: P(name: p.name, country: h.country.isEmpty ? h.countryCode : h.country, code: h.countryCode, items: [])].items.append(it)
      }
    }
    let places = placeCount.values
      .sorted { $0.items.count != $1.items.count ? $0.items.count > $1.items.count : $0.name != $1.name ? $0.name < $1.name : $0.code < $1.code }
      .prefix(top)
      .map { Recap.PlaceCount(name: $0.name, country: $0.country, countryCode: $0.code, count: $0.items.count, cover: highlights($0.items, 1, calendar: cal).first ?? $0.items[0]) }

    let ids = Set(list.map(\.id))
    let ppl = people.map { Recap.PersonCount(key: $0.key, count: $0.items.filter { ids.contains($0) }.count) }
      .filter { $0.count > 0 }
      .sorted { $0.count != $1.count ? $0.count > $1.count : $0.key < $1.key }
      .prefix(top)

    let favs = list.filter { $0.favorite && usable($0) }
    return Recap(
      year: year,
      photos: list.filter { $0.kind == .image }.count,
      videos: list.filter { $0.kind == .video }.count,
      days: Set(list.map { Trips.day($0.when, cal) }).count,
      places: Array(places),
      countries: countries.count,
      people: Array(ppl),
      months: months.keys.sorted().map { m in Recap.Month(month: m, total: months[m]!.count, highlights: highlights(months[m]!, perMonth, calendar: cal)) },
      cover: highlights(favs.isEmpty ? list : favs, 1, calendar: cal).first ?? list[0]
    )
  }
}

/** One page of the year in review played as a story (the same order as the web and Android apps). */
public enum RecapSlide: Sendable, Hashable {
  case cover
  /** a month with photos, 1 = January */
  case month(Int)
  /** a trip of the year, by its key */
  case trip(String)
  case places
  case people
  case end
}

extension Recaps {
  /** Trips shown in the story at most: the longest ones by item count. */
  public static let storyTrips = 3

  /** The story's pages: the cover, each month with photos (each trip right after the month it starts in; a trip that
   *  began the year before after January, or the first month with photos), the places, the people, the end. `trips` are the year's trips as key, start
   *  (ms) and item count; at most `storyTrips` of them, the longest, are shown. */
  public static func slides(year: Int, months: [Int], trips: [(key: String, start: Double, count: Int)], places: Bool, people: Bool,
                            calendar cal: Calendar = .current) -> [RecapSlide] {
    let chosen = trips
      .sorted { $0.count != $1.count ? $0.count > $1.count : $0.start != $1.start ? $0.start < $1.start : $0.key < $1.key }
      .prefix(storyTrips)
      .sorted { $0.start != $1.start ? $0.start < $1.start : $0.key < $1.key }
    let ms = months.sorted()
    // the month slide each trip follows: the last month with photos on or before the one it starts in, else the first
    func anchor(_ start: Double) -> Int {
      let d = Date(timeIntervalSince1970: start / 1000)
      let y = cal.component(.year, from: d)
      let m = y < year ? 1 : y > year ? 12 : cal.component(.month, from: d)
      return ms.last { $0 <= m } ?? ms.first ?? 0
    }
    var after: [Int: [String]] = [:]
    for t in chosen { after[anchor(t.start), default: []].append(t.key) }
    var out: [RecapSlide] = [.cover]
    for m in ms {
      out.append(.month(m))
      out += (after[m] ?? []).map(RecapSlide.trip)
    }
    if places { out.append(.places) }
    if people { out.append(.people) }
    out.append(.end)
    return out
  }

  /** A recap's story pages; `trips` are the trips starting or ending in its year, `people` whether any named person is in it. */
  public static func slides(_ r: Recap, trips: [Trip], people: Bool, calendar cal: Calendar = .current) -> [RecapSlide] {
    slides(year: r.year, months: r.months.map(\.month), trips: trips.map { (key: $0.key, start: $0.start, count: $0.items.count) },
           places: !r.places.isEmpty, people: people, calendar: cal)
  }

  /** A month's photos in the story, its best first: the first favorite among the highlights, else the middle one. */
  public static func storyPhotos(_ m: Recap.Month) -> [Item] {
    guard !m.highlights.isEmpty else { return [] }
    let best = m.highlights.firstIndex(where: \.favorite) ?? (m.highlights.count - 1) / 2
    var l = m.highlights
    let b = l.remove(at: best)
    return [b] + l
  }
}
