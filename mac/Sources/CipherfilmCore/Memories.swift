// Memories, "On this day": the photos taken around today's date in earlier years, one group per year. Worked out on
// this Mac from the decrypted capture dates; nothing about it goes to the server. The same rules as the web and
// Android apps (web/src/memories/memories.ts): keep the two in step, MemoriesTests checks the same cases.
//
// Dates are the capture time's local calendar day, the same day the timeline puts a photo under.
import Foundation

public struct Memory: Identifiable, Sendable {
  public var id: Int { year }
  /** the earlier year whose date this is */
  public let year: Int
  public let yearsAgo: Int
  /** the photos, oldest first (sampled when there are more than `Memories.maxPerYear`) */
  public let items: [Item]
  /** how many there were before sampling */
  public let total: Int
  public let cover: Item
  /** the cover's capture date: its day is what the card says */
  public var date: Date { cover.date }
}

public enum Memories {
  /** How many days before and after today's date a photo may be taken to count (in each earlier year). */
  public static let windowDays = 3
  /** At most this many photos per year: a big day is sampled evenly across its time span. */
  public static let maxPerYear = 200

  private static let screenshot = try! NSRegularExpression(pattern: "screenshot|screen[ _-]?shot|bildschirmfoto|screen[ _-]?recording|bildschirmaufnahme|^scr_|^scrn", options: [.caseInsensitive])
  public static func looksLikeScreenshot(_ name: String) -> Bool {
    screenshot.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
  }

  /** Evenly spread picks of n out of list, the first and last included. */
  public static func sample<T>(_ list: [T], _ n: Int) -> [T] {
    if list.count <= n { return list }
    if n <= 1 { return Array(list.prefix(max(0, n))) }
    return (0..<n).map { i in list[Int((Double(i * (list.count - 1)) / Double(n - 1)).rounded())] }
  }

  /** An image rather than a video, not a screenshot, with a thumbnail, from the middle of the set; falls back step by step. */
  public static func cover(_ items: [Item]) -> Item? {
    let tiers = [
      items.filter { $0.kind == .image && $0.hasThumb && !looksLikeScreenshot($0.name) },
      items.filter { $0.kind == .image && $0.hasThumb },
      items.filter(\.hasThumb),
      items,
    ]
    guard let pool = tiers.first(where: { !$0.isEmpty }) else { return nil }
    return pool[(pool.count - 1) / 2]
  }

  /** A calendar day as a whole number, so a difference is in days whatever the DST. */
  private static func dayNo(_ y: Int, _ m: Int, _ d: Int) -> Int {
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    let date = utc.date(from: DateComponents(year: y, month: m, day: d))!
    return Int((date.timeIntervalSince1970 / 86_400).rounded())
  }
  /** Today's month and day in year y: 29 February becomes the 28th in a year without it. */
  private static func anchor(_ y: Int, _ m: Int, _ d: Int) -> Int {
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
    let days = utc.range(of: .day, in: .month, for: utc.date(from: DateComponents(year: y, month: m, day: 1))!)!.count
    return dayNo(y, m, min(d, days))
  }

  /**
   * The memories for `now`, newest year first: for each earlier year with photos within `window` days of today's
   * date in that year, one group. Trashed, unreadable and non-media items are left out. A photo near New Year counts
   * for the year whose date it is close to.
   */
  public static func find(_ items: [Item], now: Date = Date(), calendar: Calendar = .current, window: Int = windowDays, max: Int = maxPerYear) -> [Memory] {
    let t = calendar.dateComponents([.year, .month, .day], from: now)
    guard let ty = t.year, let tm = t.month, let td = t.day else { return [] }
    var byYear: [Int: [Item]] = [:]
    for it in items {
      guard !it.broken, it.trashedAt == nil, it.meta != nil, it.kind == .image || it.kind == .video else { continue }
      let d = calendar.dateComponents([.year, .month, .day], from: it.date)
      guard let y = d.year, let m = d.month, let dd = d.day, y <= ty else { continue }
      let day = dayNo(y, m, dd)
      var best: Int?, bestDiff = Int.max
      for ay in [y - 1, y, y + 1] where ay < ty {
        let diff = abs(day - anchor(ay, tm, td))
        if diff <= window && diff < bestDiff { best = ay; bestDiff = diff }
      }
      if let b = best { byYear[b, default: []].append(it) }
    }
    return byYear.compactMap { year, list -> Memory? in
      let all = list.sorted { $0.when != $1.when ? $0.when < $1.when : $0.id < $1.id }
      let shown = sample(all, max)
      guard let c = cover(shown) else { return nil }
      return Memory(year: year, yearsAgo: ty - year, items: shown, total: all.count, cover: c)
    }.sorted { $0.year > $1.year }
  }

  /** "3 years ago" */
  public static func yearsAgo(_ n: Int) -> String { n == 1 ? "1 year ago" : "\(n) years ago" }
}
