// Place names on this Mac (docs/MAP.md): the file scripts/places.mjs builds from GeoNames (CC BY 4.0), every place with
// at least 1,000 people. A photo's coordinates are looked up here, never sent anywhere. The same reader as
// web/src/places/places.ts (the web and Android apps), with the same answers; the format is described at the top of
// scripts/places.mjs. The app bundles web/src/places/places-v1.bin as it is (scripts/map-assets.sh).
import Foundation

public struct Place: Sendable, Equatable {
  public let name: String
  /** the admin1 region, e.g. "Zurich"; "" when GeoNames has none */
  public let region: String
  /** English name, e.g. "Switzerland" */
  public let country: String
  /** "CH" */
  public let countryCode: String
  /** the place's own coordinates (not the photo's) */
  public let lat: Double
  public let lon: Double
}

/** What nearest() found: a place within 50 km, or only the country (within 300 km). */
public struct PlaceHit: Sendable, Equatable {
  public let place: Place?
  public let country: String
  public let countryCode: String
  public let km: Double
  /** the place's index (for match()), -1 when only the country is known */
  public let index: Int

  /** "Zürich, Switzerland"; the country alone when the photo is far from any place. */
  public var label: String { place.map { "\($0.name), \($0.country)" } ?? country }

  /** For search: town, region, country and its code, as written and without accents, so "zurich", "Zürich",
   *  "switzerland" and "ch" all find the photo (web/src/map/locations.ts placeWords). */
  public var words: String {
    let w = [place?.name ?? "", place?.region ?? "", country, countryCode].filter { !$0.isEmpty }.joined(separator: " ")
    return "\(w) \(Places.fold(w))"
  }
}

public struct PlaceMatch: Sendable, Equatable {
  public var places = Set<Int>()
  public var admins = Set<Int>()
  public var countries = Set<Int>()
}

public final class Places: @unchecked Sendable {
  public enum Failure: Error { case notAPlaceFile, cutShort }

  static let cell = 1.0 // grid cell in degrees for the nearest-place search
  static let nearKm = 50.0 // farther than this from every place: no place name (but still the country)
  static let countryKm = 300.0 // farther than this: not even a country (open sea)

  public let count: Int
  private let lat: [Int32]
  private let lon: [Int32]
  private let admin: [UInt16]
  private let country: [UInt8]
  public let size: [UInt8]
  public let names: [String]
  public let countries: [(code: String, name: String)]
  public let admins: [(country: Int, name: String)]
  private var grid: [Int: [Int32]] = [:]
  private let lock = NSLock()
  private var folded: [String]?

  public convenience init(contentsOf url: URL) throws { try self.init(data: Data(contentsOf: url, options: .mappedIfSafe)) }

  public init(data: Data) throws {
    let b = [UInt8](data)
    guard b.count >= 16, b[0] == 0x43, b[1] == 0x46, b[2] == 0x50, b[3] == 0x4C, b[4] == 1 else { throw Failure.notAPlaceFile }
    func u32(_ o: Int) -> UInt32 { UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24 }
    let n = Int(u32(8)), jsonLen = Int(u32(12))
    var at = 16
    guard b.count >= at + n * 12 + jsonLen else { throw Failure.cutShort }
    var la = [Int32](repeating: 0, count: n), lo = la
    for i in 0..<n { la[i] = Int32(bitPattern: u32(at + 4 * i)) }
    at += 4 * n
    for i in 0..<n { lo[i] = Int32(bitPattern: u32(at + 4 * i)) }
    at += 4 * n
    var ad = [UInt16](repeating: 0, count: n)
    for i in 0..<n { ad[i] = UInt16(b[at + 2 * i]) | UInt16(b[at + 2 * i + 1]) << 8 }
    at += 2 * n
    let co = Array(b[at..<at + n]); at += n
    let sz = Array(b[at..<at + n]); at += n
    struct Meta: Decodable { let countries: [[String]]; let admins: [[Meta.Value]]
      enum Value: Decodable {
        case i(Int), s(String)
        init(from d: Decoder) throws {
          let c = try d.singleValueContainer()
          if let v = try? c.decode(Int.self) { self = .i(v) } else { self = .s(try c.decode(String.self)) }
        }
      }
    }
    let meta = try JSONDecoder().decode(Meta.self, from: Data(b[at..<at + jsonLen]))
    at += jsonLen
    countries = meta.countries.map { (code: $0.first ?? "", name: $0.count > 1 ? $0[1] : "") }
    admins = meta.admins.map { v in
      var c = 0, s = ""
      for x in v { switch x { case .i(let i): c = i; case .s(let t): s = t } }
      return (country: c, name: s)
    }
    var ns: [String] = []
    ns.reserveCapacity(n)
    var start = at
    var i = at
    while ns.count < n && i < b.count {
      if b[i] == 0 { ns.append(String(decoding: b[start..<i], as: UTF8.self)); start = i + 1 }
      i += 1
    }
    // the last name may end without its 0 byte (the JS reader splits on 0 and takes n)
    if ns.count < n && start < b.count { ns.append(String(decoding: b[start..<b.count], as: UTF8.self)) }
    guard ns.count == n else { throw Failure.cutShort }
    count = n; lat = la; lon = lo; admin = ad; country = co; size = sz; names = ns
    if co.contains(where: { Int($0) >= countries.count }) { throw Failure.notAPlaceFile }
    var g: [Int: [Int32]] = [:]
    for i in 0..<n { g[Self.cellOf(Double(la[i]) / 1e5, Double(lo[i]) / 1e5), default: []].append(Int32(i)) }
    grid = g
  }

  static func cellOf(_ lat: Double, _ lon: Double) -> Int {
    let x = (((lon + 180).truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
    return Int(((lat + 90) / cell).rounded(.down)) * 1000 + Int((x / cell).rounded(.down))
  }

  public func place(_ i: Int) -> Place {
    let a = admin[i]
    let c = countries[Int(country[i])]
    let region = a == 65535 || Int(a) >= admins.count ? "" : admins[Int(a)].name
    return Place(name: names[i], region: region, country: c.name, countryCode: c.code, lat: Double(lat[i]) / 1e5, lon: Double(lon[i]) / 1e5)
  }

  /** The nearest place within 50 km; a photo farther from every place gets only its country (within 300 km), at sea
   *  nothing. */
  public func nearest(_ la: Double, _ lo: Double) -> PlaceHit? {
    guard la.isFinite, lo.isFinite, abs(la) <= 90, abs(lo) <= 180 else { return nil }
    var best = -1
    var bestKm = Double.infinity
    // rings of cells around the photo, until the best found is nearer than the ring could hold anything closer
    for r in 0...4 {
      for dy in -r...r {
        for dx in -r...r where max(abs(dx), abs(dy)) == r {
          let y = la + Double(dy) * Self.cell
          if y < -90 || y > 90 { continue }
          guard let list = grid[Self.cellOf(y, lo + Double(dx) * Self.cell)] else { continue }
          for j in list {
            let i = Int(j)
            let d = Places.km(la, lo, Double(lat[i]) / 1e5, Double(lon[i]) / 1e5)
            if d < bestKm { bestKm = d; best = i }
          }
        }
      }
      if best >= 0 && bestKm < Double(r) * Self.cell * 111 * max(0.2, cos(la * .pi / 180)) { break }
    }
    guard best >= 0, bestKm <= Self.countryKm else { return nil }
    let p = place(best)
    return bestKm <= Self.nearKm
      ? PlaceHit(place: p, country: p.country, countryCode: p.countryCode, km: bestKm, index: best)
      : PlaceHit(place: nil, country: p.country, countryCode: p.countryCode, km: bestKm, index: -1)
  }

  /** Places whose name, region or country starts with what is typed ("zur", "zürich", "switzerland"; a country also
   *  by its code, "ch"): the place, region and country indices. Under 2 letters nothing; under 3 only whole names. */
  public func match(_ query: String) -> PlaceMatch {
    let q = Places.fold(query)
    var out = PlaceMatch()
    guard q.count >= 2 else { return out }
    let long = q.count >= 3
    let f = foldedNames()
    for i in 0..<count where f[i] == q || (long && f[i].hasPrefix(q)) { out.places.insert(i) }
    for (i, a) in admins.enumerated() { let n = Places.fold(a.name); if n == q || (long && n.hasPrefix(q)) { out.admins.insert(i) } }
    for (i, c) in countries.enumerated() {
      let n = Places.fold(c.name)
      if n == q || (long && n.hasPrefix(q)) || c.code.lowercased() == q { out.countries.insert(i) }
    }
    return out
  }

  private func foldedNames() -> [String] {
    lock.lock(); defer { lock.unlock() }
    if let folded { return folded }
    let f = names.map(Places.fold)
    folded = f
    return f
  }

  public func adminOf(_ i: Int) -> Int { Int(admin[i]) }
  public func countryOf(_ i: Int) -> Int { Int(country[i]) }

  /** Lower case, no accents, trimmed: "Zürich" and "zurich" match (the same as places.ts fold: NFD, then the combining
   *  marks U+0300 to U+036F dropped). */
  public static func fold(_ s: String) -> String {
    var u = String.UnicodeScalarView()
    for c in s.decomposedStringWithCanonicalMapping.unicodeScalars where !(0x300...0x36F).contains(c.value) { u.append(c) }
    return String(u).lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /** Great-circle distance in km. */
  public static func km(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
    let r = Double.pi / 180
    let a = pow(sin((lat2 - lat1) * r / 2), 2) + cos(lat1 * r) * cos(lat2 * r) * pow(sin((lon2 - lon1) * r / 2), 2)
    return 2 * 6371 * asin(min(1, a.squareRoot()))
  }
}

extension Item {
  /** Coordinates a camera really wrote: in range, and not exactly 0,0 (what broken GPS writes); none for a broken or
   *  trashed item (web/src/map/locations.ts coords). */
  public var location: GPS? {
    guard !broken, trashedAt == nil, let g = meta?.gps else { return nil }
    guard g.lat.isFinite, g.lon.isFinite, abs(g.lat) <= 90, abs(g.lon) <= 180, !(g.lat == 0 && g.lon == 0) else { return nil }
    return g
  }
}

extension Places {
  /** What a set of photos' places have in common (as web/src/places/places.ts summary): the place when all are in the
   *  same one, else the countries, most photos first; nil when none is near a place. */
  public static func title(_ hits: [PlaceHit?]) -> String? {
    let found = hits.compactMap { $0 }
    guard !found.isEmpty else { return nil }
    let labels = Set(found.map(\.label))
    if labels.count == 1, found.count == hits.count { return labels.first }
    var count: [String: Int] = [:]
    for h in found where !h.country.isEmpty { count[h.country, default: 0] += 1 }
    let c = count.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
    switch c.count {
    case 0: return nil
    case 1: return c[0]
    case 2: return "\(c[0]) and \(c[1])"
    default: return "\(c[0]), \(c[1]) and \(c.count - 2) more"
    }
  }
}
