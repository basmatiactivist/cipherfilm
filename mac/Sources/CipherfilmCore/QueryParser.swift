// One search box, many kinds of words (docs/SEARCH.md "Combined search"): "dog beach May 2025 Anna Rome" or
// "Hund Strand 2025 Anna Rom" is the photos of Anna, taken in Rome in May 2025, that show a dog on a beach.
// A careful port of web/src/search/parse.ts (the web and Android apps' parser): the same cases
// (web/src/search/parse-cases.json) run here in QueryParserTests, so every app reads a query alike. Pure: nothing is
// looked up here but what the caller passes.
//
// JavaScript details kept: whitespace is JavaScript's \s, letters and digits are \p{L} and \p{N}, comparisons are by
// Unicode scalar (all strings compared are folded to NFC first).
import Foundation

public enum QueryParser {
  public struct Context {
    /** Names of the account's named people (hidden ones left out). */
    public var people: [String]
    /** A place name for a folded phrase of one to three words ("rom", "new york"), when the library has photos there:
     *  the canonical name ("Rome"), else nil. */
    public var place: ((String) -> String?)?
    /** Today, "YYYY-MM-DD", for "this year" and "last year". */
    public var today: String
    public init(people: [String], place: ((String) -> String?)? = nil, today: String) { self.people = people; self.place = place; self.today = today }
  }

  /** A date filter. All parts given must hold: from/to are inclusive local dates ("YYYY-MM-DD"); months (0...11) and
   *  days (1...31) are inclusive ranges, [first, last], that hold in any year. */
  public struct When: Codable, Equatable, Hashable, Sendable {
    public var from: String?
    public var to: String?
    public var months: [Int]?
    public var days: [Int]?
    public init(from: String? = nil, to: String? = nil, months: [Int]? = nil, days: [Int]? = nil) { self.from = from; self.to = to; self.months = months; self.days = days }
  }

  public enum Kind: String, Codable, Sendable { case person, place, date, favorites, videos, screenshots }

  /** What a part of the query was taken as, with the words it covers: tokens [start, end) of the query split at
   *  whitespace. Removing the chip removes those words (removeChip). */
  public struct Chip: Equatable, Hashable, Sendable {
    public var kind: Kind
    public var start: Int
    public var end: Int
    public var names: [String]?
    public var place: String?
    public var when: When?
  }

  public struct Parsed: Equatable, Sendable {
    public var chips: [Chip]
    /** Each entry is one name in the query; a photo needs one of its people (two Annas: either). All entries hold. */
    public var people: [[String]]
    public var places: [String]
    public var dates: [When]
    public var favorites: Bool
    public var videos: Bool
    public var screenshots: Bool
    /** The words left, lower case: matched against file names, cameras and the text in photos. */
    public var text: String
    /** The same words for the image model, which knows English: common German words in English ("hund" → "dog"). */
    public var clip: String
  }

  // ---- characters as JavaScript sees them ----

  /** JavaScript's \s (and what String.prototype.trim removes). */
  static func isSpace(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
  }

  /** \p{L} or \p{N}. */
  static func isWordChar(_ u: Unicode.Scalar) -> Bool {
    switch u.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
         .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
  }

  static func isMark(_ u: Unicode.Scalar) -> Bool {
    switch u.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark: return true
    default: return false
    }
  }

  /** s split at runs of whitespace, empty pieces dropped. */
  static func split(_ s: String) -> [String] {
    var out: [String] = []
    var cur = String.UnicodeScalarView()
    for u in s.unicodeScalars {
      if isSpace(u) { if !cur.isEmpty { out.append(String(cur)); cur = String.UnicodeScalarView() } } else { cur.append(u) }
    }
    if !cur.isEmpty { out.append(String(cur)) }
    return out
  }

  static func isASCIIDigit(_ u: Unicode.Scalar) -> Bool { u.value >= 0x30 && u.value <= 0x39 }

  /** Lower case, accents dropped, ß as ss: "Zürich" and "zurich", "Müller" and "muller" match. */
  public static func fold(_ s: String) -> String {
    var u = String.UnicodeScalarView()
    for c in s.decomposedStringWithCanonicalMapping.unicodeScalars where !isMark(c) { u.append(c) }
    return String(u).lowercased().replacingOccurrences(of: "ß", with: "ss").precomposedStringWithCanonicalMapping
  }

  /** Query tokens: the query split at whitespace, as typed. Chips point into this list. */
  public static func tokens(_ q: String) -> [String] { split(q) }

  /** Without the characters around it that are neither letters nor digits. */
  static func trim(_ t: String) -> String {
    let s = Array(t.unicodeScalars)
    guard let a = s.firstIndex(where: isWordChar), let b = s.lastIndex(where: isWordChar) else { return "" }
    var u = String.UnicodeScalarView(); u.append(contentsOf: s[a...b])
    return String(u)
  }

  /** A token without the punctuation around it, folded: "Mai," → "mai"; one of only punctuation ("-") stays. */
  static func word(_ t: String) -> String { let f = fold(t), w = trim(f); return w.isEmpty ? f : w }
  static func hasWord(_ t: String) -> Bool { t.unicodeScalars.contains(where: isWordChar) }

  /** Same scalars (not Swift's canonical equivalence; the strings compared are NFC already). */
  static func same(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }

  // ---- words ----

  static let months: [String: Int] = {
    var m: [String: Int] = [:]
    for (i, n) in ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].enumerated() { m[n] = i; m[String(n.prefix(3))] = i }
    for (i, n) in ["januar", "februar", "marz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"].enumerated() { m[n] = i; m[String(n.prefix(3))] = i }
    m["janner"] = 0; m["maerz"] = 2; m["sept"] = 8; m["okt"] = 9; m["dez"] = 11
    return m
  }()

  static let rangeTo: Set<String> = ["to", "bis", "-", "–", "until", "till", "and", "und"]
  static let rangeFrom: Set<String> = ["from", "von", "between", "zwischen"]
  static let since: Set<String> = ["since", "seit", "after", "nach", "ab"]
  static let before: Set<String> = ["before", "vor"]
  static let christmas: Set<String> = ["christmas", "xmas", "weihnachten"]
  /** Words before a filter that belong to it: "dog in Rome", "photos with Anna", "from 2024". */
  static let lead: Set<String> = ["in", "im", "at", "from", "von", "aus", "bei", "near", "on", "am", "during", "wahrend", "with", "mit", "of"]
  /** Words that mean "any photo": dropped from what is searched for. */
  static let filler: Set<String> = ["photo", "photos", "picture", "pictures", "pics", "pic", "image", "images", "foto", "fotos", "bild", "bilder", "aufnahmen"]
  /** parse.ts FLAGS, its regular expressions written out (the words are folded, so lower case). */
  static let flags: [(Kind, Set<String>)] = [
    (.favorites, ["favorite", "favorites", "favourite", "favourites", "favorit", "favoriten", "fav", "favs", "liked", "herz", "heart", "hearts", "lieblingsfotos", "lieblingsbilder"]),
    (.videos, ["video", "videos", "film", "filme", "clip", "clips", "movie", "movies"]),
    (.screenshots, ["screenshot", "screenshots", "bildschirmfoto", "bildschirmfotos"]),
  ]
  /** Small words a photo's text needn't contain for a match ("the" in "the bakery"). */
  static let stop: Set<String> = ["a", "an", "the", "and", "or", "of", "in", "on", "at", "with", "der", "die", "das", "ein", "eine", "und", "oder", "im", "am", "mit", "auf", "von"]

  // ---- dates ----

  static func isYear(_ w: String?) -> Bool {
    guard let w else { return false }
    let s = Array(w.unicodeScalars)
    return s.count == 4 && s.allSatisfy(isASCIIDigit) && (w.hasPrefix("19") || w.hasPrefix("20"))
  }

  static func pad(_ n: Int) -> String { n < 10 && n >= 0 ? "0\(n)" : "\(n)" }

  static func lastDay(_ y: Int, _ m: Int) -> Int {
    switch m {
    case 1: return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 ? 29 : 28
    case 3, 5, 8, 10: return 30
    default: return 31
    }
  }

  static func yearsWhen(_ a: Int, _ b: Int) -> When { When(from: "\(a)-01-01", to: "\(b)-12-31") }
  static func monthsWhen(_ y: Int, _ a: Int, _ b: Int) -> When { When(from: "\(y)-\(pad(a + 1))-01", to: "\(y)-\(pad(b + 1))-\(pad(lastDay(y, b)))") }

  /** ASCII digit groups separated by the given single characters: "2025-05-04" with ["-", "-"] → [2025, 5, 4];
   *  lens: allowed digit counts of each group. nil when it isn't exactly that. */
  static func numbers(_ s: String, seps: [[Unicode.Scalar]], lens: [ClosedRange<Int>]) -> [String]? {
    var groups: [String] = []
    var cur = ""
    var k = 0
    for u in s.unicodeScalars {
      if isASCIIDigit(u) { cur.unicodeScalars.append(u); continue }
      guard k < seps.count, seps[k].contains(u), !cur.isEmpty else { return nil }
      groups.append(cur); cur = ""; k += 1
    }
    groups.append(cur)
    guard groups.count == lens.count else { return nil }
    for (g, l) in zip(groups, lens) where !l.contains(g.count) { return nil }
    return groups
  }

  struct Found { var kind: Kind; var len: Int; var names: [String]? = nil; var place: String? = nil; var when: When? = nil }

  /** A date starting at word i: "2025", "2019-2021", "2019 bis 2021", "May 2025", "Mai bis Juli 2025", "since 2020",
   *  "christmas 2023", "2025-05", "24.12.2023", "last year". */
  static func dateAt(_ w: [String], _ i: Int, today: String) -> Found? {
    func at(_ k: Int) -> String? { k < w.count ? w[k] : nil }
    let a = w[i], b = at(i + 1), c = at(i + 2)
    let thisYear = Int(today.prefix(4)) ?? 0
    // "last year", "this year", "letztes Jahr", "dieses Jahr", "vorletztes jahr"
    if b == "year" || b == "jahr", ["last", "letztes", "this", "dieses", "vorletztes"].contains(a) {
      let y = a == "this" || a == "dieses" ? thisYear : a == "vorletztes" ? thisYear - 2 : thisYear - 1
      return Found(kind: .date, len: 2, when: yearsWhen(y, y))
    }
    // exact days and months typed as numbers
    if let m = numbers(a, seps: [["-"], ["-"]], lens: [4...4, 1...2, 1...2]), isYear(m[0]) {
      let day = "\(m[0])-\(pad(Int(m[1])!))-\(pad(Int(m[2])!))"
      return Found(kind: .date, len: 1, when: When(from: day, to: day))
    }
    if let m = numbers(a, seps: [["."], ["."]], lens: [1...2, 1...2, 4...4]), isYear(m[2]) {
      let day = "\(m[2])-\(pad(Int(m[1])!))-\(pad(Int(m[0])!))"
      return Found(kind: .date, len: 1, when: When(from: day, to: day))
    }
    if let m = numbers(a, seps: [["-"]], lens: [4...4, 1...2]), isYear(m[0]), let mo = Int(m[1]), mo >= 1 && mo <= 12 {
      return Found(kind: .date, len: 1, when: monthsWhen(Int(m[0])!, mo - 1, mo - 1))
    }
    // year ranges: "2019-2021", "2019–2021"
    if let m = numbers(a, seps: [["-", "–"]], lens: [4...4, 4...4]), isYear(m[0]), isYear(m[1]) {
      let p = Int(m[0])!, q = Int(m[1])!
      return Found(kind: .date, len: 1, when: yearsWhen(min(p, q), max(p, q)))
    }
    // "from 2019 to 2021", "zwischen 2019 und 2021", "2019 bis 2021"
    let ld = rangeFrom.contains(a) ? 1 : 0
    let y0 = at(i + ld), sep = at(i + ld + 1), y1 = at(i + ld + 2)
    if isYear(y0), let sep, rangeTo.contains(sep), isYear(y1) {
      let p = Int(y0!)!, q = Int(y1!)!
      return Found(kind: .date, len: ld + 3, when: yearsWhen(min(p, q), max(p, q)))
    }
    if since.contains(a), isYear(b) { return Found(kind: .date, len: 2, when: When(from: "\(Int(b!)! + (a == "after" || a == "nach" ? 1 : 0))-01-01")) }
    if before.contains(a) || a == "until" || a == "bis", isYear(b) {
      return Found(kind: .date, len: 2, when: When(to: a == "before" || a == "vor" ? "\(Int(b!)! - 1)-12-31" : "\(b!)-12-31"))
    }
    // christmas, with or without a year
    if christmas.contains(a) {
      if isYear(b) { return Found(kind: .date, len: 2, when: When(from: "\(b!)-12-20", to: "\(b!)-12-27")) }
      return Found(kind: .date, len: 1, when: When(months: [11, 11], days: [20, 27]))
    }
    // months: "may", "may 2025", "2025 may", "may to july", "mai bis juli 2025"
    if var m0 = months[a] {
      var m1 = m0, len = 1
      if let b, rangeTo.contains(b), let c, let mc = months[c] { m1 = mc; len = 3 }
      let y = at(i + len)
      if m1 < m0 { swap(&m0, &m1) }
      if isYear(y) { return Found(kind: .date, len: len + 1, when: monthsWhen(Int(y!)!, m0, m1)) }
      return Found(kind: .date, len: len, when: When(months: [m0, m1]))
    }
    if isYear(a) {
      if let b, let mb = months[b] { return Found(kind: .date, len: 2, when: monthsWhen(Int(a)!, mb, mb)) }
      return Found(kind: .date, len: 1, when: yearsWhen(Int(a)!, Int(a)!))
    }
    return nil
  }

  struct Who { let name: String; let parts: [String] }

  /** People whose name is the words at i (all of it: "anna müller") or one word of it ("anna"). Longest first. */
  static func personAt(_ w: [String], _ i: Int, _ people: [Who]) -> Found? {
    for len in [3, 2] {
      if i + len > w.count { continue }
      let phrase = w[i..<i + len].joined(separator: " ")
      let hits = people.filter { same($0.parts.joined(separator: " "), phrase) }
      if !hits.isEmpty { return Found(kind: .person, len: len, names: hits.map(\.name)) }
    }
    let hits = people.filter { $0.parts.contains { same($0, w[i]) } }
    return hits.isEmpty ? nil : Found(kind: .person, len: 1, names: hits.map(\.name))
  }

  static func placeAt(_ w: [String], _ i: Int, _ place: ((String) -> String?)?) -> Found? {
    guard let place else { return nil }
    for len in [3, 2, 1] {
      if i + len > w.count { continue }
      if let name = place(w[i..<i + len].joined(separator: " ")) { return Found(kind: .place, len: len, place: name) }
    }
    return nil
  }

  // ---- the query ----

  public static func parse(_ q: String, _ ctx: Context) -> Parsed {
    let raw = tokens(q)
    let w = raw.map(word)
    let people = ctx.people
      .map { name in Who(name: name, parts: split(fold(name)).map(trim).filter { !$0.isEmpty }) }
      .filter { !$0.parts.isEmpty }
    var chips: [Chip] = []
    var used = [Bool](repeating: false, count: raw.count)
    var i = 0
    while i < w.count {
      if !hasWord(w[i]) { i += 1; continue }
      let flag = flags.first { $0.1.contains(w[i]) }
      guard let f = personAt(w, i, people) ?? dateAt(w, i, today: ctx.today) ?? flag.map({ Found(kind: $0.0, len: 1) }) ?? placeAt(w, i, ctx.place) else { i += 1; continue }
      var start = i
      // a word like "in" or "with" right before it goes with it, unless it is all that is left before
      if start > 0 && lead.contains(w[start - 1]) && !used[start - 1] { start -= 1 }
      chips.append(Chip(kind: f.kind, start: start, end: i + f.len, names: f.names, place: f.place, when: f.when))
      for k in start..<(i + f.len) { used[k] = true }
      i += f.len
    }
    var rest = w.enumerated().filter { k, x in !used[k] && hasWord(x) && !filler.contains(x) }.map(\.element)
    // a word like "in" left over at the very end ("dog in") means nothing
    while let l = rest.last, lead.contains(l) { rest.removeLast() }
    while let f = rest.first, lead.contains(f) { rest.removeFirst() }
    return Parsed(
      chips: chips,
      people: chips.filter { $0.kind == .person }.map { $0.names! },
      places: chips.filter { $0.kind == .place }.map { $0.place! },
      dates: chips.filter { $0.kind == .date }.map { $0.when! },
      favorites: chips.contains { $0.kind == .favorites },
      videos: chips.contains { $0.kind == .videos },
      screenshots: chips.contains { $0.kind == .screenshots },
      text: rest.joined(separator: " "),
      clip: rest.map { glossary[$0] ?? $0 }.joined(separator: " ")
    )
  }

  /** The query without a chip's words: what the search box holds after the chip's × was pressed. */
  public static func removeChip(_ q: String, _ chip: Chip) -> String {
    tokens(q).enumerated().filter { $0.offset < chip.start || $0.offset >= chip.end }.map(\.element).joined(separator: " ")
  }

  /** Whether a photo taken on this local day ("YYYY-MM-DD") passes a date filter. */
  public static func inWhen(_ when: When, _ day: String) -> Bool {
    if let f = when.from, day < f { return false }
    if let t = when.to, day > t { return false }
    let s = Array(day.utf8)
    func num(_ r: Range<Int>) -> Int { r.upperBound <= s.count ? Int(String(decoding: s[r], as: UTF8.self)) ?? 0 : 0 }
    let m = num(5..<7) - 1, d = num(8..<10)
    if let ms = when.months, ms.count == 2, m < ms[0] || m > ms[1] { return false }
    if let ds = when.days, ds.count == 2, d < ds[0] || d > ds[1] { return false }
    return true
  }

  /** The local day of a time in milliseconds, "YYYY-MM-DD". */
  public static func localDay(_ ms: Double, calendar: Calendar = Calendar(identifier: .gregorian)) -> String {
    var cal = calendar
    cal.timeZone = .current
    let c = cal.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: ms / 1000))
    return "\(c.year ?? 0)-\(pad(c.month ?? 0))-\(pad(c.day ?? 0))"
  }

  /** Where the words are in a photo's recognised text: each query word must start a word of the text (folded, so
   *  "zurich" finds "Zürich"; "bake" finds "Bakery"). Returns a short piece of the text around the first match, as it
   *  was recognised, or nil. */
  public static func textMatch(_ text: String?, _ query: String) -> String? {
    guard let text, !text.isEmpty else { return nil }
    let qs = split(fold(query)).map(trim).filter { !$0.isEmpty && !stop.contains($0) }
    if qs.isEmpty { return nil }
    let words = split(text)
    let folded = words.map { x -> [Unicode.Scalar] in
      let s = Array(fold(x).unicodeScalars)
      return Array(s.drop { !isWordChar($0) })
    }
    var first = -1
    for q in qs {
      let qq = Array(q.unicodeScalars)
      guard let at = folded.firstIndex(where: { $0.starts(with: qq) }) else { return nil }
      if first < 0 || at < first { first = at }
    }
    let from = max(0, first - 2)
    let piece = words[from..<min(words.count, from + 8)].joined(separator: " ")
    return (from > 0 ? "…" : "") + piece + (from + 8 < words.count ? "…" : "")
  }
}

// ---- chips in words (web/src/search/combined.ts chipLabel) ----

extension QueryParser {
  static let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

  /** "May 4, 2025" for "2025-05-04". */
  static func dayLabel(_ s: String) -> String {
    let p = s.split(separator: "-").compactMap { Int($0) }
    guard p.count == 3, (1...12).contains(p[1]) else { return s }
    return "\(monthNames[p[1] - 1].prefix(3)) \(p[2]), \(p[0])"
  }

  /** A date filter in words: "2025", "May 2025", "2019–2021", "May–July", "Since 2020", "Christmas 2023". */
  public static func whenLabel(_ w: When) -> String {
    let month = { (m: Int) in (0...11).contains(m) ? monthNames[m] : "" }
    let months = w.months.map { $0.count == 2 ? ($0[0] == $0[1] ? month($0[0]) : "\(month($0[0]))–\(month($0[1]))") : "" } ?? ""
    if let d = w.days, d.first == 20, w.months?.first == 11 { return "Christmas" }
    if w.from == nil && w.to == nil { return months }
    let f = w.from?.split(separator: "-").compactMap { Int($0) } ?? []
    let t = w.to?.split(separator: "-").compactMap { Int($0) } ?? []
    guard let from = w.from, f.count == 3 else { return t.count == 3 ? (t[1] == 12 && t[2] == 31 ? "Until \(t[0])" : "Until \(dayLabel(w.to!))") : "" }
    guard let to = w.to, t.count == 3 else { return f[1] == 1 && f[2] == 1 ? "Since \(f[0])" : "Since \(dayLabel(from))" }
    if from == to { return dayLabel(from) }
    if f[1] == 12 && f[2] == 20 && t[1] == 12 && t[2] == 27 && f[0] == t[0] { return "Christmas \(f[0])" }
    if f[1] == 1 && f[2] == 1 && t[1] == 12 && t[2] == 31 { return f[0] == t[0] ? "\(f[0])" : "\(f[0])–\(t[0])" }
    if f[0] == t[0] && f[2] == 1 { return f[1] == t[1] ? "\(month(f[1] - 1)) \(f[0])" : "\(month(f[1] - 1))–\(month(t[1] - 1)) \(f[0])" }
    return "\(dayLabel(from)) – \(dayLabel(to))"
  }

  /** What a chip says. */
  public static func label(_ c: Chip) -> String {
    switch c.kind {
    case .person: return (c.names ?? []).joined(separator: " or ")
    case .place: return c.place ?? ""
    case .date: return c.when.map(whenLabel) ?? ""
    case .favorites: return "Favorites"
    case .videos: return "Videos"
    case .screenshots: return "Screenshots"
    }
  }
}
