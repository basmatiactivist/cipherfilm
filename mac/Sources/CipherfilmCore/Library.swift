// The person's library: the server's list, decrypted on this Mac. For a fast start the server's own ciphertext is kept in
// the cache folder (the item list, the encrypted thumbnails and previews); it opens only with the master key, which
// exists in memory only, so a cached copy reveals no more than the server's copy. Sign-out removes it.
import Foundation

public struct GPS: Codable, Sendable, Hashable { public var lat: Double; public var lon: Double }

public struct ItemMeta: Codable, Sendable, Hashable {
  public var name: String
  public var mime: String
  public var size: Int64
  public var lastModified: Double?
  public var capture_ts: Double
  public var width: Double?
  public var height: Double?
  public var duration: Double?
  public var make: String?
  public var model: String?
  public var gps: GPS?

  public init(name: String, mime: String, size: Int64, lastModified: Double, capture_ts: Double, width: Double? = nil, height: Double? = nil,
              duration: Double? = nil, make: String? = nil, model: String? = nil, gps: GPS? = nil) {
    self.name = name; self.mime = mime; self.size = size; self.lastModified = lastModified; self.capture_ts = capture_ts
    self.width = width; self.height = height; self.duration = duration; self.make = make; self.model = model; self.gps = gps
  }
}

public enum Kind: String, Codable, Sendable { case image, video, other }

public struct Item: Identifiable, Sendable, Hashable {
  public let id: String
  public let kind: Kind
  public let size: Int64
  public let segmentCount: Int
  public let createdAt: Double
  public let hasThumb: Bool
  public let hasPreview: Bool
  public var favorite: Bool
  public var trashedAt: Double?
  public var purgeAt: Double?
  public var meta: ItemMeta?
  public var itemKey: Data?
  /** Decryption or verification failed: never shown, the screen says so. */
  public var broken: Bool

  /** Capture time in milliseconds (the upload time when nothing better is known). */
  public var when: Double { meta?.capture_ts ?? createdAt * 1000 }
  public var date: Date { Date(timeIntervalSince1970: when / 1000) }
  public var name: String { meta?.name ?? "" }
  /** width / height, clamped like the web grid */
  public var aspect: Double {
    guard let w = meta?.width, let h = meta?.height, w > 0, h > 0 else { return 1 }
    return min(4, max(0.4, w / h))
  }

  public static func == (a: Item, b: Item) -> Bool { a.id == b.id && a.favorite == b.favorite && a.trashedAt == b.trashedAt && a.broken == b.broken }
  public func hash(into h: inout Hasher) { h.combine(id) }
}

struct RawItem: Codable, Sendable {
  let id: String
  let kind: String
  let size: Int64
  let segment_count: Int
  let wrapped_item_key: String
  let meta_enc: String
  let has_thumb: Bool
  let has_preview: Bool
  let created_at: Double
  let favorite: Bool?
  let trashed_at: Double?
  let purge_at: Double?
}

private struct Page: Decodable { let items: [RawItem]; let next: String?; let retention_days: Int? }

public struct Album: Identifiable, Sendable, Hashable {
  public let id: String
  public var name: String
  public var itemIds: [String]
  public var broken: Bool
}

/** Everything that needs the unlocked account: the API, the master key and the account's key pair. */
public final class Vault: @unchecked Sendable {
  public let api: API
  public let me: Me
  private let lock = NSLock()
  private var master: Data?
  private var pairCache: KeyPair?

  public init(api: API, me: Me, masterKey: Data) {
    self.api = api; self.me = me; self.master = masterKey
  }

  public var userId: String { me.user.id }
  public var isOpen: Bool { lock.withLock { master != nil } }

  public func masterKey() throws -> Data {
    try lock.withLock {
      guard let m = master else { throw CryptoError.failed("Unlock your library first.") }
      return m
    }
  }

  public func pair() throws -> KeyPair {
    let m = try masterKey()
    return try lock.withLock {
      if let p = pairCache { return p }
      let p = try Crypto.accountKeyPair(wrappedPrivkey: B64.decode(me.wrapped_privkey), masterKey: m, email: me.user.email)
      pairCache = p
      return p
    }
  }

  /** The public key the server sent, accepted only if it is the one computed from the private key. */
  public func checkedPublicKey() throws -> Data {
    let p = try pair()
    guard Sodium.equal(p.pk, try B64.decode(me.pubkey)) else { throw CryptoError.failed("Your account's keys don't match.") }
    return p.pk
  }

  /** Forgets the keys (lock or sign-out). */
  public func close() {
    lock.withLock {
      if var m = master { Sodium.memzero(&m) }
      if var p = pairCache?.sk { Sodium.memzero(&p) }
      master = nil; pairCache = nil
    }
  }

  // ---- the cache folder (ciphertext only) ----

  public static func cacheRoot() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/cf-ct", isDirectory: true)
  }

  public var cacheDir: URL? { Self.cacheDir(of: userId) }

  /** An account's cache folder, always inside cacheRoot(); nil for an id that isn't one. */
  public static func cacheDir(of userId: String) -> URL? {
    guard ServerId.valid(userId) else { return nil }
    return cacheRoot().appendingPathComponent(userId, isDirectory: true)
  }

  func keep(_ name: String, _ data: Data) {
    guard let dir = cacheDir else { return }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
  }

  func cached(_ name: String) -> Data? {
    guard let dir = cacheDir else { return nil }
    return try? Data(contentsOf: dir.appendingPathComponent(name))
  }

  func dropCached(_ name: String) {
    guard let dir = cacheDir else { return }
    try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
  }

  // ---- the library ----

  /** Decrypts the list on all cores: each item's key, then its metadata, checked against the server's size. The
   *  numbers are checked too (the size against the segment count, the picture's dimensions), so nothing later works
   *  with values no honest upload has. */
  private func decrypt(_ raw: [RawItem]) throws -> [Item] {
    let m = try masterKey()
    let out = UnsafeMutableBufferPointer<Item?>.allocate(capacity: raw.count)
    out.initialize(repeating: nil)
    defer { out.deallocate() }
    DispatchQueue.concurrentPerform(iterations: raw.count) { i in
      let x = raw[i]
      var it = Item(id: x.id, kind: Kind(rawValue: x.kind) ?? .other, size: x.size, segmentCount: x.segment_count, createdAt: x.created_at,
                    hasThumb: x.has_thumb, hasPreview: x.has_preview, favorite: x.favorite ?? false, trashedAt: x.trashed_at, purgeAt: x.purge_at,
                    meta: nil, itemKey: nil, broken: false)
      do {
        guard ServerId.valid(x.id) else { throw CryptoError.failed("bad item id") }
        let key = try Crypto.unwrapAnyItemKey(B64.decode(x.wrapped_item_key), master: m, pair: { try self.pair() }, itemId: x.id)
        var meta = try JSONDecoder().decode(ItemMeta.self, from: Crypto.decryptMeta(B64.decode(x.meta_enc), itemKey: key, itemId: x.id))
        guard meta.size == x.size, (0...Segments.maxTotal).contains(x.size), x.segment_count == Segments.count(x.size) else { throw CryptoError.failed("size mismatch") }
        meta.width = Self.dimension(meta.width); meta.height = Self.dimension(meta.height)
        if let d = meta.duration, !(d.isFinite && d >= 0 && d < 1e7) { meta.duration = nil }
        it.itemKey = key; it.meta = meta
      } catch {
        it.broken = true
      }
      out[i] = it
    }
    return out.compactMap { $0 }.sorted { $0.when > $1.when }
  }

  /** A width or height as a picture can have it, else none. */
  static func dimension(_ v: Double?) -> Double? {
    guard let v, v.isFinite, v >= 1, v <= 1_000_000 else { return nil }
    return v
  }

  private func pages(_ path: String) async throws -> ([RawItem], Int?) {
    var raw: [RawItem] = []
    var next = ""
    var days: Int?
    repeat {
      let q = next.isEmpty ? "" : "?after=" + (next.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? next)
      let p = try JSONDecoder().decode(Page.self, from: try await api.json("GET", path + q))
      raw += p.items
      days = p.retention_days ?? days
      next = p.next ?? ""
    } while !next.isEmpty
    return (raw, days)
  }

  /** The whole library, newest capture first. */
  public func loadLibrary() async throws -> [Item] {
    _ = try masterKey()
    let (raw, _) = try await pages("/api/items")
    if let d = try? JSONEncoder().encode(raw) { keep("list.json", d) }
    return try decrypt(raw)
  }

  /** The list as it was last loaded, shown at once while the current one loads. */
  public func loadCachedLibrary() -> [Item]? {
    guard let d = cached("list.json"), let raw = try? JSONDecoder().decode([RawItem].self, from: d) else { return nil }
    return try? decrypt(raw)
  }

  /** The trash, most recently trashed first, and how long the server keeps it. */
  public func loadTrash() async throws -> (items: [Item], retentionDays: Int) {
    let (raw, days) = try await pages("/api/trash")
    return (try decrypt(raw).sorted { ($0.trashedAt ?? 0) > ($1.trashedAt ?? 0) }, days ?? 30)
  }

  /** Drops cached images of items that are gone, and all but the newest 600 previews. */
  public func pruneCache(keeping ids: Set<String>) {
    guard let dir = cacheDir, let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    var previews: [(URL, Date)] = []
    for f in files where f.lastPathComponent != "list.json" && f.lastPathComponent != "index.json" {
      let parts = f.lastPathComponent.split(separator: "-")
      guard parts.count == 2, ["thumb", "preview"].contains(parts[0]), ids.contains(String(parts[1])) else { try? FileManager.default.removeItem(at: f); continue }
      if parts[0] == "preview" { previews.append((f, (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)) }
    }
    for (f, _) in previews.sorted(by: { $0.1 > $1.1 }).dropFirst(600) { try? FileManager.default.removeItem(at: f) }
  }

  // ---- thumbnails, previews, originals ----

  private static let idRe = try! NSRegularExpression(pattern: "^[0-9a-f]{32}$")
  private static func okId(_ id: String) -> Bool { idRe.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil }

  public enum Picture: String, Sendable { case thumb, preview }

  /** The decrypted JPEG of a thumbnail or preview; the verified ciphertext is kept in the cache. */
  public func picture(_ kind: Picture, of it: Item) async throws -> Data {
    guard let key = it.itemKey else { throw CryptoError.failed("no key") }
    let name = "\(kind.rawValue)-\(it.id)"
    let open: (Data) throws -> Data = { ct in
      _ = try self.masterKey()
      return kind == .thumb ? try Crypto.decryptThumb(ct, itemKey: key, itemId: it.id) : try Crypto.decryptPreview(ct, itemKey: key, itemId: it.id)
    }
    if Self.okId(it.id), let ct = cached(name) {
      if let p = try? open(ct) { return p }
      if isOpen { dropCached(name) }
    }
    let ct = try await api.getBytes("/api/items/\(it.id)/\(kind.rawValue)")
    let p = try open(ct) // only verified ciphertext is kept
    if Self.okId(it.id) { keep(name, ct) }
    return p
  }

  /** Many thumbnails at once, decrypted: from the cache folder where they are, the rest in batches of up to 100 in one
   *  request (POST /api/items/thumbs). Throws APIError 404/405 when the server is older than that endpoint. */
  public func thumbnails(_ items: [Item]) async throws -> [String: Data] {
    var out: [String: Data] = [:]
    var missing: [Item] = []
    for it in items {
      guard let key = it.itemKey else { continue }
      if Self.okId(it.id), let ct = cached("thumb-\(it.id)"), let p = try? Crypto.decryptThumb(ct, itemKey: key, itemId: it.id) { out[it.id] = p }
      else if it.hasThumb { missing.append(it) }
    }
    for chunk in missing.chunked(100) {
      let body = try await api.json("POST", "/api/items/thumbs", body: ["item_ids": chunk.map(\.id)], timeout: 60)
      var o = 0
      let b = [UInt8](body)
      for it in chunk {
        guard o + 4 <= b.count else { break }
        let n = Int(UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3]))
        o += 4
        if n == 0xFFFF_FFFF { continue }
        guard o + n <= b.count else { break }
        let ct = Data(b[o..<(o + n)])
        o += n
        if let key = it.itemKey, let p = try? Crypto.decryptThumb(ct, itemKey: key, itemId: it.id) { // only verified ciphertext is kept
          out[it.id] = p
          if Self.okId(it.id) { keep("thumb-\(it.id)", ct) }
        }
      }
    }
    return out
  }

  /** The best picture the server has of an item (for search and faces). */
  public func bestPicture(of it: Item) async throws -> Data {
    try await picture(it.hasPreview ? .preview : .thumb, of: it)
  }

  /** One decrypted segment of the original file. */
  public func segment(_ i: Int, of it: Item) async throws -> Data {
    guard let key = it.itemKey else { throw CryptoError.failed("no key") }
    let ct = try await api.getBytes("/api/items/\(it.id)/segments/\(i)")
    return try Segments.decrypt(itemKey: key, itemId: it.id, index: i, count: it.segmentCount, total: it.size, blob: ct)
  }

  /** The original file, decrypted into a file at `to`: written next to it first (or in `staging`, for a place the person
   *  picked in a save panel, where macOS allows writing only that one file), then moved into place. */
  public func saveOriginal(_ it: Item, to dest: URL, staging: URL? = nil, progress: (@Sendable (Double) -> Void)? = nil) async throws {
    if let staging { try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true) }
    let tmp = (staging ?? dest.deletingLastPathComponent()).appendingPathComponent(".cf-\(UUID().uuidString).part")
    FileManager.default.createFile(atPath: tmp.path, contents: nil)
    do {
      let fh = try FileHandle(forWritingTo: tmp)
      defer { try? fh.close() }
      // the count the size gives (decrypt() checked the server's against it); every segment is verified
      guard (0...Segments.maxTotal).contains(it.size), it.segmentCount == Segments.count(it.size) else { throw CryptoError.failed("size mismatch") }
      let n = it.segmentCount
      var next: Task<Data, Error>? = Task { try await self.segment(0, of: it) }
      var written: Int64 = 0
      for i in 0..<n {
        try Task.checkCancellation()
        let cur = try await next!.value
        next = i + 1 < n ? Task { try await self.segment(i + 1, of: it) } : nil
        try fh.write(contentsOf: cur)
        written += Int64(cur.count)
        progress?(Double(i + 1) / Double(n))
      }
      try fh.close()
      guard written == it.size else { throw CryptoError.failed("size mismatch") }
      if FileManager.default.fileExists(atPath: dest.path) { _ = try FileManager.default.replaceItemAt(dest, withItemAt: tmp) }
      else { try FileManager.default.moveItem(at: tmp, to: dest) }
    } catch {
      try? FileManager.default.removeItem(at: tmp)
      throw error
    }
  }

  // ---- changes ----

  public func trash(_ ids: [String]) async throws { for c in ids.chunked(500) { try await api.json("POST", "/api/items/trash", body: ["item_ids": c]) } }
  public func restore(_ ids: [String]) async throws { for c in ids.chunked(500) { try await api.json("POST", "/api/items/restore", body: ["item_ids": c]) } }
  public func purge(_ ids: [String]) async throws { for c in ids.chunked(500) { try await api.json("POST", "/api/trash/purge", body: ["item_ids": c]) } }
  public func setFavorite(_ ids: [String], _ on: Bool) async throws {
    for c in ids.chunked(500) { try await api.json("POST", "/api/items/favorite", body: ["item_ids": c, "favorite": on] as [String: Any]) }
  }

  // ---- albums: names encrypted under the master key, bound to the album id ----

  private struct RawAlbum: Decodable { let id: String; let name_enc: String; let item_ids: [String] }

  public func loadAlbums() async throws -> [Album] {
    struct R: Decodable { let albums: [RawAlbum] }
    let m = try masterKey()
    let r = try await api.get(R.self, "/api/albums")
    return r.albums.map { a in
      if let n = try? Crypto.decryptAlbumName(B64.decode(a.name_enc), master: m, albumId: a.id) { return Album(id: a.id, name: n, itemIds: a.item_ids, broken: false) }
      return Album(id: a.id, name: "Unreadable album", itemIds: a.item_ids, broken: true)
    }
  }

  public func createAlbum(_ name: String) async throws -> Album {
    let id = Hex.encode(Sodium.random(16))
    let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
    try await api.json("POST", "/api/albums", body: ["id": id, "name_enc": B64.encode(Crypto.encryptAlbumName(clean, master: try masterKey(), albumId: id))])
    return Album(id: id, name: clean, itemIds: [], broken: false)
  }

  public func renameAlbum(_ id: String, _ name: String) async throws -> String {
    let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
    try await api.json("PATCH", "/api/albums/\(id)", body: ["name_enc": B64.encode(Crypto.encryptAlbumName(clean, master: try masterKey(), albumId: id))])
    return clean
  }

  public func deleteAlbum(_ id: String) async throws { try await api.json("DELETE", "/api/albums/\(id)") }

  public func addToAlbum(_ id: String, _ items: [String]) async throws {
    for c in items.chunked(500) { try await api.json("PUT", "/api/albums/\(id)/items", body: ["item_ids": c]) }
  }

  public func removeFromAlbum(_ id: String, _ items: [String]) async throws {
    for i in items { try await api.json("DELETE", "/api/albums/\(id)/items/\(i)") }
  }
}

extension Array {
  func chunked(_ n: Int) -> [[Element]] { stride(from: 0, to: count, by: n).map { Array(self[$0..<Swift.min($0 + n, count)]) } }
}
