// Custom reviews: a search the person saved ("dogs", "Anna in Zürich"), played as a story like the year in review, once
// a day, week or month, with different photos each time. The same rules as the web and Android apps
// (web/src/memories/custom.ts), checked against the same fixture (web/src/memories/testdata/custom.json,
// CustomReviewTests). The search itself is the Mac's own (SearchEngine); this only works out when a review is due,
// which of its matches it shows, and the slides.
//
// The reviews live in one document per account, encrypted with the master key (Crypto.encryptReviews): the server
// stores it and tells the other devices when it changed, and never learns what a review searches for, what it's
// called or which photos it showed (docs/MEMORIES.md "Custom reviews").
import Foundation

// ---- a JSON value: the document is read through it, so a damaged one never fails and a newer app's fields stay ----

public enum JSONValue: Codable, Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n):
      // whole numbers as integers (times in ms, periods), as JSON.stringify writes them
      if n.rounded() == n, abs(n) < 9e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  var string: String? { if case .string(let s) = self { return s }; return nil }
  var number: Double? { if case .number(let n) = self, n.isFinite { return n }; return nil }
  var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
  var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
}

public struct Review: Sendable, Hashable, Identifiable {
  public enum Every: String, Sendable, CaseIterable, Hashable { case day, week, month }

  /** random, 16 hex characters */
  public var id: String
  public var name: String
  /** what's typed in search: words, people, places, dates */
  public var query: String
  public var every: Every
  public var count: Int
  /** a notification when it's due (Android only; kept as it is here) */
  public var notify: Bool
  public var created: Double
  public var updated: Double
  /** fields a newer app added: kept, so this one doesn't drop them when it saves */
  public var extra: [String: JSONValue] = [:]

  public init(id: String, name: String, query: String, every: Every, count: Int, notify: Bool, created: Double, updated: Double, extra: [String: JSONValue] = [:]) {
    self.id = id; self.name = name; self.query = query; self.every = every; self.count = count; self.notify = notify
    self.created = created; self.updated = updated; self.extra = extra
  }
}

public struct ReviewShown: Sendable, Hashable {
  /** the period it was last watched in (periodOf) */
  public var period: Int
  /** the photos shown, oldest first */
  public var ids: [String]
  /** what that period's story showed, so it plays the same again until the next period */
  public var now: [String]
  public init(period: Int, ids: [String], now: [String]) { self.period = period; self.ids = ids; self.now = now }
}

public struct ReviewDoc: Sendable, Hashable {
  public var reviews: [Review] = []
  public var shown: [String: ReviewShown] = [:]
  /** review id → when it was deleted (ms) */
  public var deleted: [String: Double] = [:]
  public init() {}
}

public enum ReviewError: Error, LocalizedError, Equatable {
  case noQuery, tooMany
  public var errorDescription: String? {
    switch self {
    case .noQuery: return "A review needs something to search for."
    case .tooMany: return "At most \(CustomReviews.maxReviews) reviews."
    }
  }
}

/** One page of a custom review played as a story. */
public enum ReviewSlide: Sendable, Hashable {
  case rcover(item: Item, name: String, total: Int, shown: Int)
  case ryear(year: Int, photos: [Item])
  case rend
}

public enum CustomReviews {
  /** How many photos a review can show. */
  public static let counts = [6, 12, 20, 30]
  public static let maxReviews = 20
  /** Photos remembered per review as shown (newest last). */
  public static let maxShown = 600
  public static let maxText = 80
  /** How long a deleted review's marker is kept, so a device that hadn't seen the delete can't bring it back. */
  public static let keepDeletedMs = 90.0 * 86_400_000
  /** Photos on one slide of a review at most. */
  public static let perSlide = 6

  // ---- periods, in local time ----

  private static func floorDiv(_ a: Int, _ b: Int) -> Int { Int((Double(a) / Double(b)).rounded(.down)) }
  private static func mod(_ a: Int, _ b: Int) -> Int { ((a % b) + b) % b }

  /** Days since 1970-01-01 of a calendar date (proleptic Gregorian). */
  static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  static func civilFromDays(_ z0: Int) -> (y: Int, m: Int, d: Int) {
    let z = z0 + 719_468
    let era = floorDiv(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    return (yoe + era * 400 + (m <= 2 ? 1 : 0), m, d)
  }

  /** The number of the day, week (Monday to Sunday) or month a moment falls in; 0 is the one with 1970-01-01. */
  public static func periodOf(_ every: Review.Every, _ date: Date, calendar: Calendar = .current) -> Int {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    let y = c.year ?? 1970, m = c.month ?? 1, d = c.day ?? 1
    if every == .month { return (y - 1970) * 12 + (m - 1) }
    let day = daysFromCivil(y, m, d)
    // 1970-01-01 was a Thursday: its week began on Monday, three days before
    return every == .week ? floorDiv(day + 3, 7) : day
  }

  /** Where a period starts (local midnight). */
  public static func periodStart(_ every: Review.Every, _ p: Int, calendar: Calendar = .current) -> Date {
    let comps: DateComponents
    if every == .month {
      comps = DateComponents(year: 1970 + floorDiv(p, 12), month: mod(p, 12) + 1, day: 1)
    } else {
      let c = civilFromDays(every == .week ? p * 7 - 3 : p)
      comps = DateComponents(year: c.y, month: c.m, day: c.d)
    }
    return calendar.date(from: comps) ?? Date()
  }

  /** Due: not watched yet in this period (on any device). */
  public static func isDue(_ r: Review, _ doc: ReviewDoc, now: Date, calendar: Calendar = .current) -> Bool {
    guard let s = doc.shown[r.id] else { return true }
    return s.period < periodOf(r.every, now, calendar: calendar)
  }

  /** When it's due next: now, if it's due; else the start of the next period. */
  public static func nextDue(_ r: Review, _ doc: ReviewDoc, now: Date, calendar: Calendar = .current) -> Date {
    isDue(r, doc, now: now, calendar: calendar) ? now : periodStart(r.every, periodOf(r.every, now, calendar: calendar) + 1, calendar: calendar)
  }

  // ---- picking ----

  /** FNV-1a (32 bits) of the review id and the period, so every device picks the same in a period. */
  public static func seedOf(_ id: String, _ period: Int) -> UInt32 {
    var h: UInt32 = 0x811c9dc5
    for b in "\(id):\(period)".utf8 { h = (h ^ UInt32(b)) &* 0x01000193 }
    return h
  }

  /** mulberry32: small, fast, and the same as the TypeScript one; numbers in [0, 1). */
  public struct Mulberry32: Sendable {
    private var a: UInt32
    public init(_ seed: UInt32) { a = seed }
    public mutating func next() -> Double {
      a = a &+ 0x6d2b79f5
      var t = (a ^ (a >> 15)) &* (1 | a)
      t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
      return Double(t ^ (t >> 14)) / 4_294_967_296
    }
  }

  /** Can be shown: has a picture, isn't damaged, trashed or in the locked folder. */
  public static func showable(_ i: Item) -> Bool {
    !i.broken && i.trashedAt == nil && i.hasThumb && !i.isLocked && (i.kind == .image || i.kind == .video)
  }

  static func byTime(_ a: Item, _ b: Item) -> Bool { a.when != b.when ? a.when < b.when : a.id < b.id }
  private static func plain(_ i: Item) -> Bool { i.kind == .image && !Memories.looksLikeScreenshot(i.name) }

  /**
   * The photos a review shows this time, in capture order:
   * 1. the matches not shown lately; when there are fewer than `count`, those shown longest ago fill up;
   * 2. spread over the months they were taken in: the months in a random order, one photo from each in turn, a
   *    favorite twice as likely as another photo, screenshots and videos only where a month has nothing else.
   * `shown`: the review's history, oldest first. `seed`: seedOf(review, period).
   */
  public static func pickReview(_ matches: [Item], count: Int, shown: [String], seed: UInt32, calendar cal: Calendar = .current) -> [Item] {
    var seen: [String: Int] = [:]
    for (k, id) in shown.enumerated() { seen[id] = k }
    var ids = Set<String>()
    let all = matches.filter { showable($0) && ids.insert($0.id).inserted }.sorted(by: byTime)
    let fresh = all.filter { seen[$0.id] == nil }
    let pool = fresh.count >= count ? fresh
      : fresh + all.filter { seen[$0.id] != nil }.sorted { seen[$0.id]! < seen[$1.id]! }.prefix(max(0, count - fresh.count))

    var rnd = Mulberry32(seed)
    func monthOf(_ i: Item) -> Int { let c = cal.dateComponents([.year, .month], from: i.date); return c.year! * 12 + c.month! - 1 }
    var months: [Int: [Item]] = [:]
    for m in pool { months[monthOf(m), default: []].append(m) }
    var order = months.keys.sorted()
    var k = order.count - 1
    while k > 0 {
      let j = Int((rnd.next() * Double(k + 1)).rounded(.down))
      order.swapAt(k, j)
      k -= 1
    }

    var out: [Item] = []
    while out.count < count && !order.isEmpty {
      var g = 0
      while g < order.count && out.count < count {
        var left = months[order[g]]!
        let nice = left.filter(plain)
        let from = nice.isEmpty ? left : nice
        let weight = { (m: Item) -> Double in m.favorite ? 2 : 1 }
        let total = from.reduce(0) { $0 + weight($1) }
        var r = rnd.next() * total, i = 0
        while i < from.count - 1 {
          r -= weight(from[i])
          if r < 0 { break }
          i += 1
        }
        let chosen = from[i]
        out.append(chosen)
        left.remove(at: left.firstIndex { $0.id == chosen.id }!)
        months[order[g]] = left
        if left.isEmpty { order.remove(at: g) } else { g += 1 }
      }
    }
    return out.sorted(by: byTime)
  }

  /** What this period's story showed, if it was watched in this period and those photos are still there. */
  public static func replayed(_ doc: ReviewDoc, id: String, period: Int, matches: [Item]) -> [Item]? {
    guard let s = doc.shown[id], s.period == period else { return nil }
    let want = Set(s.now)
    var ids = Set<String>()
    let got = matches.filter { want.contains($0.id) && showable($0) && ids.insert($0.id).inserted }
    return got.isEmpty ? nil : got.sorted(by: byTime)
  }

  // ---- the document ----

  /** Remembers that a review was watched in a period with these photos. */
  public static func recordShown(_ doc: ReviewDoc, id: String, period: Int, ids: [String]) -> ReviewDoc {
    var d = doc
    var set = Set<String>()
    let now = ids.filter { set.insert($0).inserted }
    let prev = (d.shown[id]?.ids ?? []).filter { !set.contains($0) }
    d.shown[id] = ReviewShown(period: period, ids: Array((prev + now).suffix(maxShown)), now: now)
    return d
  }

  private static let spaces = try! NSRegularExpression(pattern: "\\s+")
  static func clean(_ s: String) -> String {
    let one = spaces.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
    return String(one.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxText))
  }

  /** The nearest of `counts` (the smaller on a tie). */
  static func snap(_ n: Int) -> Int {
    counts.reduce(counts[0]) { best, c in abs(c - n) < abs(best - n) ? c : best }
  }

  /** Adds a review or changes one (by id). A review deleted on another device stays deleted. Throws without a query
   *  or when there are `maxReviews` already. */
  public static func upsertReview(_ doc: ReviewDoc, _ r: Review, now: Double) throws -> ReviewDoc {
    let query = clean(r.query)
    if query.isEmpty { throw ReviewError.noQuery }
    if doc.deleted[r.id] != nil { return doc }
    var d = doc
    var next = r
    next.query = query
    let name = clean(r.name)
    next.name = name.isEmpty ? query : name
    next.count = snap(r.count)
    next.updated = now
    if let k = d.reviews.firstIndex(where: { $0.id == r.id }) {
      // another rhythm counts its periods in other units: due at once, the photos shown are still remembered
      if d.reviews[k].every != next.every, var s = d.shown[r.id] { s.period = -1; s.now = []; d.shown[r.id] = s }
      d.reviews[k] = next
    } else if d.reviews.count >= maxReviews {
      throw ReviewError.tooMany
    } else {
      next.created = now
      d.reviews.append(next)
    }
    return d
  }

  public static func deleteReview(_ doc: ReviewDoc, id: String, now: Double) -> ReviewDoc {
    var d = doc
    d.reviews.removeAll { $0.id == id }
    d.shown[id] = nil
    d.deleted[id] = now
    return d
  }

  /** Drops delete markers older than keepDeletedMs and the history of reviews that are gone. */
  public static func tidy(_ doc: ReviewDoc, now: Double) -> ReviewDoc {
    var d = doc
    d.deleted = d.deleted.filter { now - $0.value <= keepDeletedMs }
    let ids = Set(d.reviews.map(\.id))
    d.shown = d.shown.filter { ids.contains($0.key) }
    return d
  }

  private static func review(_ v: JSONValue) -> Review? {
    guard let o = v.object, let id = o["id"]?.string, !id.isEmpty, let name = o["name"]?.string,
          let query = o["query"]?.string, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let every = o["every"]?.string.flatMap(Review.Every.init(rawValue:)), let count = o["count"]?.number,
          let created = o["created"]?.number, let updated = o["updated"]?.number else { return nil }
    let known: Set<String> = ["id", "name", "query", "every", "count", "notify", "created", "updated"]
    var notify = false
    if case .bool(let b)? = o["notify"] { notify = b }
    let c = count.rounded(.up)
    return Review(id: id, name: name, query: query, every: every, count: abs(c) < 1e9 ? Int(c) : 12, notify: notify,
                  created: created, updated: updated, extra: o.filter { !known.contains($0.key) })
  }

  private static func shown(_ v: JSONValue) -> ReviewShown? {
    guard let o = v.object, let p = o["period"]?.number, abs(p) < 1e12, let ids = o["ids"]?.array else { return nil }
    let list = ids.compactMap(\.string)
    guard list.count == ids.count else { return nil }
    var now: [String] = []
    if let n = o["now"] {
      guard let a = n.array else { return nil }
      now = a.compactMap(\.string)
      guard now.count == a.count else { return nil }
    }
    return ReviewShown(period: Int(p), ids: list, now: now)
  }

  /** The document as opened: anything damaged left out, anything a newer app added to a review kept. */
  public static func readDoc(_ raw: JSONValue?) -> ReviewDoc {
    var d = ReviewDoc()
    guard let r = raw?.object else { return d }
    if let a = r["reviews"]?.array { d.reviews = Array(a.compactMap(review).prefix(maxReviews)) }
    if let s = r["shown"]?.object { for (k, v) in s { if let x = shown(v) { d.shown[k] = x } } }
    if let s = r["deleted"]?.object { for (k, v) in s { if let n = v.number { d.deleted[k] = n } } }
    return d
  }

  /** The document as it is read from its JSON (the decrypted bytes); a damaged one is an empty one. */
  public static func readDoc(_ data: Data) -> ReviewDoc {
    readDoc(try? JSONDecoder().decode(JSONValue.self, from: data))
  }

  /** The document as JSON, with the same keys as the web and Android apps. */
  public static func json(_ d: ReviewDoc) -> JSONValue {
    let reviews: [JSONValue] = d.reviews.map { r in
      var o = r.extra
      o["id"] = .string(r.id); o["name"] = .string(r.name); o["query"] = .string(r.query); o["every"] = .string(r.every.rawValue)
      o["count"] = .number(Double(r.count)); o["notify"] = .bool(r.notify); o["created"] = .number(r.created); o["updated"] = .number(r.updated)
      return .object(o)
    }
    let shown = d.shown.mapValues { s -> JSONValue in
      .object(["period": .number(Double(s.period)), "ids": .array(s.ids.map(JSONValue.string)), "now": .array(s.now.map(JSONValue.string))])
    }
    return .object(["v": .number(1), "reviews": .array(reviews), "shown": .object(shown), "deleted": .object(d.deleted.mapValues(JSONValue.number))])
  }

  public static func encode(_ d: ReviewDoc) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    return try e.encode(json(d))
  }

  // ---- the story ----

  /** The slides of a review: the cover (its first favorite, else its middle photo), the photos by year (perSlide a
   *  slide at most), the end. `picked`: pickReview's or replayed's answer; `total`: how many photos match the search. */
  public static func slides(_ r: Review, picked: [Item], total: Int, calendar cal: Calendar = .current) -> [ReviewSlide] {
    guard !picked.isEmpty else { return [.rend] }
    let images = picked.filter { $0.kind == .image }
    let cover = picked.first { $0.favorite && $0.kind == .image } ?? (images.isEmpty ? picked[0] : images[(images.count - 1) / 2])
    var out: [ReviewSlide] = [.rcover(item: cover, name: r.name, total: total, shown: picked.count)]
    var years: [Int: [Item]] = [:]
    for p in picked { years[cal.component(.year, from: p.date), default: []].append(p) }
    for y in years.keys.sorted() {
      let photos = years[y]!
      for k in stride(from: 0, to: photos.count, by: perSlide) { out.append(.ryear(year: y, photos: Array(photos[k..<min(photos.count, k + perSlide)]))) }
    }
    out.append(.rend)
    return out
  }
}
