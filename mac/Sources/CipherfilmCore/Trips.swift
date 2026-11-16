// Trips: photos taken far from home on consecutive days, offered as suggested albums. Worked out on this Mac from the
// decrypted capture dates and coordinates; nothing about it goes to the server unless the person saves a trip as an
// album (then it is an ordinary encrypted album). The same rules as the web and Android apps
// (web/src/memories/trips.ts): keep them in step, TripsTests checks the same fixture (web/src/memories/testdata).
//
// Days are the capture time's local calendar day, the same day the timeline puts a photo under.
import Foundation

public enum Where: Sendable, Equatable {
  case place(name: String, country: String, countryCode: String)
  case region(name: String, country: String, countryCode: String)
  case country(country: String, countryCode: String)
  case countries([(country: String, countryCode: String)])
  case none

  public static func == (a: Where, b: Where) -> Bool {
    switch (a, b) {
    case let (.place(n1, c1, k1), .place(n2, c2, k2)), let (.region(n1, c1, k1), .region(n2, c2, k2)): return n1 == n2 && c1 == c2 && k1 == k2
    case let (.country(c1, k1), .country(c2, k2)): return c1 == c2 && k1 == k2
    case let (.countries(l1), .countries(l2)): return l1.map(\.countryCode) == l2.map(\.countryCode) && l1.map(\.country) == l2.map(\.country)
    case (.none, .none): return true
    default: return false
    }
  }
}

public struct Trip: Identifiable, Sendable {
  public var id: String { key }
  /** stable while the trip's first photo stays: "trip-<first day>-<first id>" */
  public let key: String
  /** the photos, oldest first: those taken away, and those without a location taken between the first and the last */
  public let items: [Item]
  /** capture times (ms) of the first and the last photo taken away */
  public let start: Double
  public let end: Double
  /** different days with photos taken away */
  public let days: Int
  public let place: Where
  public let home: GPS
}

public enum Trips {
  /** A photo counts as away when it was taken farther than this from home. */
  public static let minKm = 80.0
  /** At most this many days without any photo may fall inside a trip. */
  public static let maxGapDays = 1
  /** A trip has at least this many photos taken away, on at least minDays different days. */
  public static let minItems = 5
  public static let minDays = 2
  /** Home is looked for in cells of this many degrees (about 25 km). */
  public static let homeCellDeg = 0.25
  /** A year with photos on at least this many days has a home of its own; others use the whole library's. */
  public static let homeYearMinDays = 30

  public typealias Lookup = @Sendable (Double, Double) -> PlaceHit?

  /** Counts at all: not trashed, not broken, a photo or a video with its metadata. */
  static func counts(_ it: Item) -> Bool { !it.broken && it.trashedAt == nil && it.meta != nil && (it.kind == .image || it.kind == .video) }

  /** Coordinates a camera really wrote: in range, and not exactly 0,0. */
  static func gps(_ it: Item) -> GPS? {
    guard let g = it.meta?.gps, g.lat.isFinite, g.lon.isFinite, abs(g.lat) <= 90, abs(g.lon) <= 180, !(g.lat == 0 && g.lon == 0) else { return nil }
    return g
  }

  /** The local calendar day as a whole number (days since 1970), whatever the DST. */
  static func day(_ ms: Double, _ cal: Calendar) -> Int {
    let d = cal.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: ms / 1000))
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    let date = utc.date(from: DateComponents(year: d.year, month: d.month, day: d.day))!
    return Int((date.timeIntervalSince1970 / 86_400).rounded())
  }
  static func year(_ ms: Double, _ cal: Calendar) -> Int { cal.component(.year, from: Date(timeIntervalSince1970: ms / 1000)) }

  /** Great-circle distance in km (the same as places.ts). */
  public static func km(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let r = Double.pi / 180
    let a = pow(sin((lat2 - lat1) * r / 2), 2) + cos(lat1 * r) * cos(lat2 * r) * pow(sin((lon2 - lon1) * r / 2), 2)
    return 2 * 6371 * asin(min(1, a.squareRoot()))
  }

  private static func median(_ xs: [Double]) -> Double {
    let s = xs.sorted(), m = s.count / 2
    return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  struct Pt { let lat: Double; let lon: Double; let day: Int }

  /** Home: the cell with photos on the most different days, then the most photos, then the lower cell; its photos'
   *  median coordinates. */
  static func home(_ points: [Pt]) -> GPS? {
    guard !points.isEmpty else { return nil }
    struct Cell { var days = Set<Int>(); var pts: [Pt] = []; let la: Int; let lo: Int }
    var cells: [String: Cell] = [:]
    for p in points {
      let la = Int(floor(p.lat / homeCellDeg)), lo = Int(floor(p.lon / homeCellDeg))
      let k = "\(la),\(lo)"
      var c = cells[k] ?? Cell(la: la, lo: lo)
      c.days.insert(p.day); c.pts.append(p)
      cells[k] = c
    }
    var best: Cell?
    for c in cells.values {
      guard let b = best else { best = c; continue }
      if c.days.count > b.days.count || (c.days.count == b.days.count && (c.pts.count > b.pts.count ||
        (c.pts.count == b.pts.count && (c.la < b.la || (c.la == b.la && c.lo < b.lo))))) { best = c }
    }
    return GPS(lat: median(best!.pts.map(\.lat)), lon: median(best!.pts.map(\.lon)))
  }

  /** What a trip's photos have in common: the place holding at least half of those with a known place, else such a
   *  region, else their country, else their countries (most photos first, then by code). */
  public static func place(_ hits: [PlaceHit?]) -> Where {
    struct Count { var n = 0; let name: String; let country: String; let code: String }
    var places: [String: Count] = [:], regions: [String: Count] = [:], countries: [String: Count] = [:]
    var total = 0
    for case let h? in hits where !h.countryCode.isEmpty {
      total += 1
      let code = h.countryCode, country = h.country.isEmpty ? code : h.country
      countries[code, default: Count(name: code, country: country, code: code)].n += 1
      if let p = h.place {
        places["\(p.name)\u{0}\(code)", default: Count(name: p.name, country: country, code: code)].n += 1
        if !p.region.isEmpty { regions["\(p.region)\u{0}\(code)", default: Count(name: p.region, country: country, code: code)].n += 1 }
      }
    }
    guard total > 0 else { return .none }
    let top = { (m: [String: Count]) in m.values.sorted { $0.n != $1.n ? $0.n > $1.n : $0.name < $1.name }.first }
    if let p = top(places), p.n * 2 >= total { return .place(name: p.name, country: p.country, countryCode: p.code) }
    if let r = top(regions), r.n * 2 >= total { return .region(name: r.name, country: r.country, countryCode: r.code) }
    let cs = countries.values.sorted { $0.n != $1.n ? $0.n > $1.n : $0.code < $1.code }
    if cs.count == 1 { return .country(country: cs[0].country, countryCode: cs[0].code) }
    return .countries(cs.map { (country: $0.country, countryCode: $0.code) })
  }

  /**
   * The trips in a library, newest first. Home is worked out per year (homeYearMinDays), else from the whole library.
   * A photo farther than minKm from home is away; away photos on days at most maxGapDays apart make one trip, until a
   * day with photos only at home. Photos without a location taken during a trip belong to it.
   */
  public static func find(_ items: [Item], lookup: Lookup? = nil, calendar cal: Calendar = .current) -> [Trip] {
    struct X { let it: Item; let ts: Double; let day: Int; let g: GPS? }
    var all: [X] = []
    for it in items where counts(it) {
      let ts = it.when
      guard ts.isFinite else { continue }
      all.append(X(it: it, ts: ts, day: day(ts, cal), g: gps(it)))
    }
    all.sort { $0.ts != $1.ts ? $0.ts < $1.ts : $0.it.id < $1.it.id }
    let located = all.filter { $0.g != nil }
    guard let overall = home(located.map { Pt(lat: $0.g!.lat, lon: $0.g!.lon, day: $0.day) }) else { return [] }
    var byYear: [Int: [Pt]] = [:]
    for x in located { byYear[year(x.ts, cal), default: []].append(Pt(lat: x.g!.lat, lon: x.g!.lon, day: x.day)) }
    var homes: [Int: GPS] = [:]
    for (y, pts) in byYear { homes[y] = Set(pts.map(\.day)).count >= homeYearMinDays ? home(pts)! : overall }

    final class Day { let day: Int; var away: [X] = []; var atHome = false; let homeAt: GPS; init(_ d: Int, _ h: GPS) { day = d; homeAt = h } }
    var days: [Day] = []
    for x in located {
      let homeAt = homes[year(x.ts, cal)] ?? overall
      if days.last?.day != x.day { days.append(Day(x.day, homeAt)) }
      let d = days[days.count - 1]
      if km(x.g!.lat, x.g!.lon, d.homeAt.lat, d.homeAt.lon) > minKm { d.away.append(x) } else { d.atHome = true }
    }
    var runs: [[Day]] = []
    var open = false
    for d in days {
      if d.away.isEmpty { open = false; continue }
      if open, let last = runs[runs.count - 1].last, d.day - last.day <= 1 + maxGapDays { runs[runs.count - 1].append(d) }
      else { runs.append([d]); open = true }
      // a mixed day (leaving or coming back) stays in the trip, but nothing after it joins
      if d.atHome && runs[runs.count - 1].count > 1 { open = false }
    }

    var trips: [Trip] = []
    for run in runs {
      let away = run.flatMap(\.away)
      guard away.count >= minItems, run.count >= minDays else { continue }
      let start = away[0].ts, end = away[away.count - 1].ts
      let ids = Set(away.map(\.it.id))
      let list = all.filter { ids.contains($0.it.id) || ($0.g == nil && $0.ts >= start && $0.ts <= end) }
      trips.append(Trip(key: "trip-\(run[0].day)-\(away[0].it.id)", items: list.map(\.it), start: start, end: end, days: run.count,
                        place: lookup.map { f in place(away.map { f($0.g!.lat, $0.g!.lon) }) } ?? .none, home: run[0].homeAt))
    }
    return trips.sorted { $0.start > $1.start }
  }

  /** "May 2026", "May – June 2026", "December 2025 – January 2026". */
  public static func dates(_ start: Double, _ end: Double, calendar cal: Calendar = .current, locale: Locale = Locale(identifier: "en_US")) -> String {
    let a = Date(timeIntervalSince1970: start / 1000), b = Date(timeIntervalSince1970: end / 1000)
    let f = DateFormatter(); f.locale = locale; f.calendar = cal; f.timeZone = cal.timeZone
    f.setLocalizedDateFormatFromTemplate("MMMM"); let month = f.string(from: a)
    f.setLocalizedDateFormatFromTemplate("MMMMyyyy")
    let ya = cal.component(.year, from: a), yb = cal.component(.year, from: b)
    if ya == yb && cal.component(.month, from: a) == cal.component(.month, from: b) { return f.string(from: a) }
    if ya == yb { return "\(month) – \(f.string(from: b))" }
    return "\(f.string(from: a)) – \(f.string(from: b))"
  }

  /** Where, in words: the place, region or country, "Italy and France", "Italy, France and 2 more". */
  public static func text(_ w: Where) -> String {
    switch w {
    case let .place(name, _, _), let .region(name, _, _): return name
    case let .country(country, _): return country
    case let .countries(list):
      let c = list.map(\.country)
      return c.count == 2 ? "\(c[0]) and \(c[1])" : "\(c[0]), \(c[1]) and \(c.count - 2) more"
    case .none: return ""
    }
  }

  /** "Rome, May 2026"; "Italy and France, June – July 2025". */
  public static func title(_ t: Trip, calendar: Calendar = .current) -> String {
    let w = text(t.place), when = dates(t.start, t.end, calendar: calendar)
    return w.isEmpty ? "Trip, \(when)" : "\(w), \(when)"
  }

  /** The album that already holds this trip (at least 80% of its photos), if any. */
  public static func savedAs(_ t: Trip, in albums: [Album]) -> Album? {
    let ids = t.items.map(\.id)
    return albums.first { a in
      let has = Set(a.itemIds)
      return ids.filter { has.contains($0) }.count * 5 >= ids.count * 4
    }
  }
}
