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
  /** turned and cropped in another app (PictureEdit.swift); nil when it isn't */
  public var edit: PictureEdit?
  /** the archive and the locked folder (Folders.swift): only a literal `true` counts, any other value is "not set" */
  public var archived: JSONTrue?
  public var locked: JSONTrue?
  /** the metadata's version, raised by every change of it (MetaVersion.swift); none: 0 */
  public var mv: MetaVersionNumber?
  public var version: Int { mv?.value ?? 0 }

  public init(name: String, mime: String, size: Int64, lastModified: Double, capture_ts: Double, width: Double? = nil, height: Double? = nil,
              duration: Double? = nil, make: String? = nil, model: String? = nil, gps: GPS? = nil) {
    self.name = name; self.mime = mime; self.size = size; self.lastModified = lastModified; self.capture_ts = capture_ts
    self.width = width; self.height = height; self.duration = duration; self.make = make; self.model = model; self.gps = gps
  }
}

public enum Kind: String, Codable, Sendable { case image, video, other }

public struct Item: Identifiable, Sendable, Hashable {
  public let id: String
  /** From the encrypted metadata (decrypt), never the server's plain field. */
  public var kind: Kind
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
  /** The server gave an older version of the metadata than this Mac saw before, or another copy at the version seen
   *  (MetaVersion.swift), and the newer one isn't known here any more: handled as a locked item (isLocked), never
   *  changed here. */
  public var stale: Bool = false
  /** Which sealed copy of the metadata `meta` is (MetaHighWater.digest): a change names it as its base. */
  public var base: String? = nil

  /** Capture time in milliseconds (the upload time when nothing better is known). */
  public var when: Double { meta?.capture_ts ?? createdAt * 1000 }
  public var date: Date { Date(timeIntervalSince1970: when / 1000) }
  public var name: String { meta?.name ?? "" }
  /** It decrypted and has a valid id: only such an item can be decrypted to a file. */
  public var openable: Bool { !broken && itemKey != nil && meta != nil && ServerId.valid(id) }
  /** width / height, clamped like the web grid */
  public var aspect: Double {
    guard let w = meta?.width, let h = meta?.height, w > 0, h > 0 else { return 1 }
    let e = meta?.edit?.size(width: w, height: h) ?? (w, h) // as shown: turned and cropped when it was edited
    return min(4, max(0.4, e.0 / e.1))
  }

  // a changed date, place or edit (made in another app) is a change the screens show
  public static func == (a: Item, b: Item) -> Bool { a.id == b.id && a.favorite == b.favorite && a.trashedAt == b.trashedAt && a.broken == b.broken && a.stale == b.stale && a.meta == b.meta }
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
  /** the metadata versions seen (MetaVersion.swift): kept over locks and sessions the server ended */
  public let versions: MetaHighWater
  /** the items accepted in this session whose metadata was changed at least once (version above 0), by id: when the
   *  server hands out an older copy, this one stays; dropped at every lock */
  private var accepted: [String: Item] = [:]

  /** versions: the metadata versions seen; by default this account's file (MetaHighWater.file). */
  public init(api: API, me: Me, masterKey: Data, versions: MetaHighWater? = nil) {
    self.api = api; self.me = me; self.master = masterKey
    self.versions = versions ?? MetaHighWater(file: MetaHighWater.file(for: me.user.id))
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

  /** Forgets the keys (lock or sign-out): zeroed where they are kept (a local copy would zero only itself), then let go. */
  public func close() {
    lock.withLock {
      if master != nil { Sodium.memzero(&master!) }
      if pairCache != nil { Sodium.memzero(&pairCache!.sk) }
      master = nil; pairCache = nil
      accepted = [:] // the same items (and keys) as the lists hold
      listWrite?.cancel(); listWrite = nil
    }
  }

  // ---- the cache folder (ciphertext only) ----

  public static func cacheRoot() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/cf-ct", isDirectory: true)
  }

  /** The most a list from the server (the library, the trash, the search index) may hold, and the most pages it may
   *  come in: far above any real library (the server sends 2000 per page), so a server that never ends its list can't
   *  keep this app reading. */
  public static let maxListItems = 5_000_000
  public static let maxListPages = 20_000

  public var cacheDir: URL? { Self.cacheDir(of: userId) }

  /** An account's cache folder, always inside cacheRoot(); nil for an id that isn't one. */
  public static func cacheDir(of userId: String) -> URL? {
    guard ServerId.valid(userId) else { return nil }
    return cacheRoot().appendingPathComponent(userId, isDirectory: true)
  }

  func keep(_ name: String, _ data: Data) {
    // after a lock or sign-out (work that was in flight) nothing is kept, and a deleted folder isn't made again
    guard isOpen, let dir = cacheDir else { return }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let f = dir.appendingPathComponent(name)
    if (try? data.write(to: f, options: .atomic)) != nil { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path) }
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
  func decrypt(_ raw: [RawItem]) throws -> [Item] {
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
        meta.capture_ts = Self.timestamp(meta.capture_ts) ?? Self.timestamp(x.created_at * 1000) ?? 0
        meta.lastModified = Self.timestamp(meta.lastModified)
        if meta.edit?.isIdentity == true { meta.edit = nil }
        // the kind as the authenticated metadata says, by the rule the upload used: the server's plain `kind` could
        // otherwise route this item's own bytes to the video player or the image decoder at will
        it.kind = Media.kind(name: meta.name, mime: meta.mime)
        it.itemKey = key; it.meta = meta
      } catch {
        it.broken = true
      }
      out[i] = it
    }
    return checkVersions(out.compactMap { $0 }, raw).sorted { $0.when > $1.when }
  }

  /** Each item's metadata against the versions seen (MetaVersion.swift): an older copy than seen before, or another
   *  copy at the version seen, isn't taken. The one accepted in this session stays; without it the item is stale. */
  private func checkVersions(_ items: [Item], _ raw: [RawItem]) -> [Item] {
    let enc = Dictionary(raw.map { ($0.id, $0.meta_enc) }, uniquingKeysWith: { _, b in b })
    let out: [Item] = lock.withLock {
      items.map { x in
        var it = x
        guard !it.broken, let meta = it.meta, let e = enc[it.id] else { return it }
        let d = MetaHighWater.digest(e)
        it.base = d
        if versions.check(it.id, meta.version, d) {
          if meta.version > 0 { accepted[it.id] = it }
          return it
        }
        if let k = accepted[it.id], let km = k.meta, versions.accepts(it.id, km.version, k.base) {
          it.meta = km; it.itemKey = k.itemKey; it.kind = k.kind; it.base = k.base
          return it
        }
        it.stale = true
        return it
      }
    }
    versions.flush()
    return out
  }

  /** The times in milliseconds taken as dates: 1 January 1900 to 1 January 2100. */
  static let timestamps: ClosedRange<Double> = -2_208_988_800_000...4_102_444_800_000

  /** A time in milliseconds in that range, else none. */
  static func timestamp(_ v: Double?) -> Double? {
    guard let v, v.isFinite, timestamps.contains(v) else { return nil }
    return v
  }

  /** A width or height as a picture can have it, else none. */
  static func dimension(_ v: Double?) -> Double? {
    guard let v, v.isFinite, v >= 1, v <= 1_000_000 else { return nil }
    return v
  }

  // ---- the lists, kept current with ?since (ListSync.swift) ----

  public let librarySync = ListSync(path: "/api/items", order: { $0.when > $1.when })
  public let trashSync = ListSync(path: "/api/trash", order: { ($0.trashedAt ?? 0) > ($1.trashedAt ?? 0) })
  /** the cached list read at unlock, handed to librarySync by the first load */
  private var pendingSeed: (items: [Item], records: [RawItem], cursor: String?, wholeAt: TimeInterval)?
  /** the list.json write waiting for changes to settle (a burst of uploads would otherwise rewrite it each time) */
  private var listWrite: Task<Void, Never>?

  /** What list.json holds: the server's records and the cursor they are current to (before incremental lists, the
   *  records alone). */
  private struct KeptList: Codable { let cursor: String?; var wholeAt: TimeInterval?; let items: [RawItem] }

  private func load(_ sync: ListSync) async throws -> ListSync.Loaded {
    _ = try masterKey()
    if sync === librarySync, let s = lock.withLock({ defer { pendingSeed = nil }; return pendingSeed }) {
      await sync.seed(s.items, records: s.records, cursor: s.cursor, wholeAt: s.wholeAt)
    }
    return try await sync.load(get: { [api] in try await api.json("GET", $0) }, decrypt: { [self] in try self.decrypt($0) })
  }

  /** The library, newest capture first: after the first load only what changed is fetched and decrypted. The cache
   *  keeps the records with their cursor, written when something changed. */
  public func syncLibrary() async throws -> ListSync.Loaded {
    let r = try await load(librarySync)
    if r.changed { keepList(now: r.full) }
    return r
  }

  /** Writes list.json: at once after a whole load, otherwise once changes have been quiet for 5 seconds (the list can be
   *  a few MB; a ping per upload would rewrite it each time). Records and cursor are taken together when it writes, so
   *  the file always holds a matching pair. A lock cancels a waiting write: the older file still matches its cursor. */
  private func keepList(now: Bool) {
    let sync = librarySync
    let t = Task { [weak self] in
      if !now { try? await Task.sleep(nanoseconds: 5_000_000_000) }
      guard !Task.isCancelled, let self else { return }
      let (records, cursor, wholeAt) = await sync.kept()
      guard let d = try? JSONEncoder().encode(KeptList(cursor: cursor, wholeAt: wholeAt, items: records)) else { return }
      self.lock.withLock { if !Task.isCancelled, self.master != nil { self.keep("list.json", d) } }
    }
    lock.withLock { listWrite?.cancel(); listWrite = t }
  }

  /** The whole library, newest capture first. */
  public func loadLibrary() async throws -> [Item] { try await syncLibrary().items }

  /** The list as it was last loaded, shown at once while the current one loads; with its cursor, the load after it
   *  asks only for what changed since. */
  public func loadCachedLibrary() -> [Item]? {
    guard let d = cached("list.json") else { return nil }
    let kept = (try? JSONDecoder().decode(KeptList.self, from: d)) ?? (try? JSONDecoder().decode([RawItem].self, from: d)).map { KeptList(cursor: nil, wholeAt: nil, items: $0) }
    guard let kept else { return nil }
    let records = ListSync.unique(kept.items)
    guard let items = try? decrypt(records) else { return nil }
    lock.withLock { pendingSeed = (items, records, kept.cursor, kept.wholeAt ?? 0) }
    return items
  }

  /** The trash, most recently trashed first, and how long the server keeps it. */
  public func loadTrash() async throws -> (items: [Item], retentionDays: Int) {
    let r = try await load(trashSync)
    return (r.items, r.retentionDays ?? 30)
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
    // an item in the locked folder leaves nothing on disk: never read from or written to the cache (a copy from
    // before it was moved there goes)
    let disk = Self.okId(it.id) && !it.isLocked
    if !disk && Self.okId(it.id) { dropCached(name) }
    if disk, let ct = cached(name) {
      if let p = try? open(ct) { return p }
      if isOpen { dropCached(name) }
    }
    let ct = try await api.getBytes("/api/items/\(it.id)/\(kind.rawValue)")
    let p = try open(ct) // only verified ciphertext is kept
    if disk { keep(name, ct) }
    return p
  }

  /** Many thumbnails at once, decrypted: from the cache folder where they are, the rest in batches of up to 100 in one
   *  request (POST /api/items/thumbs). Throws APIError 404/405 when the server is older than that endpoint. */
  public func thumbnails(_ items: [Item]) async throws -> [String: Data] {
    var out: [String: Data] = [:]
    var missing: [Item] = []
    for it in items {
      guard let key = it.itemKey else { continue }
      if Self.okId(it.id), !it.isLocked, let ct = cached("thumb-\(it.id)"), let p = try? Crypto.decryptThumb(ct, itemKey: key, itemId: it.id) { out[it.id] = p }
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
          if Self.okId(it.id) && !it.isLocked { keep("thumb-\(it.id)", ct) } // the locked folder: memory only
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
    guard ServerId.valid(it.id) else { throw CryptoError.failed("bad item id") }
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
  /** The item's metadata changed on another device after the copy here was decrypted: the change was not written. */
  public static let changedMeanwhile = "This item was changed on another device meanwhile. Try again."

  /** Moves items to the archive, the locked folder or back to the library: each item's metadata as the server has it
   *  (every field kept, also ones this app doesn't know), with the folder's flag set and its version raised, sealed
   *  again (Folders.resealed). Into the locked folder, its cached pictures go from disk at once. A stale item (its
   *  newest metadata isn't known here) is never written: that would undo a change on every device. The request names
   *  the copy it was made from; one another device changed meanwhile is loaded again and moved from its current
   *  metadata. */
  public func move(_ items: [Item], to folder: Folder) async throws {
    if me.isDemo { throw APIError(status: -1, message: "This is the public demo: changes are turned off.") }
    for it in items {
      do {
        try await moveOne(it, to: folder)
      } catch let e as APIError where e.status == 409 {
        // changed on another device meanwhile: once more, from the metadata as it is now
        _ = try await syncLibrary()
        let fresh = await librarySync.current().first { $0.id == it.id }
        guard let fresh else { throw APIError(status: 409, message: Self.changedMeanwhile) }
        do { try await moveOne(fresh, to: folder) } catch let e as APIError where e.status == 409 { throw APIError(status: 409, message: Self.changedMeanwhile) }
      }
    }
  }

  private func moveOne(_ it: Item, to folder: Folder) async throws {
    guard ServerId.valid(it.id), !it.broken, let key = it.itemKey else { throw CryptoError.failed("This item can't be read.") }
    guard !it.stale else { throw CryptoError.failed("This item's newest details aren't known on this Mac. Reload the library and try again.") }
    var rec = await librarySync.record(it.id)
    if rec == nil { rec = await trashSync.record(it.id) }
    guard let rec else { throw APIError(status: -1, message: "The library is still loading. Try again in a moment.") }
    // only the copy this Mac accepted is changed: a record the server sent since (another copy) is not written over
    let base = MetaHighWater.digest(rec.meta_enc)
    guard base == it.base else { throw APIError(status: 409, message: Self.changedMeanwhile) }
    let (sealed, version) = try Folders.resealedVersion(B64.decode(rec.meta_enc), itemKey: key, itemId: it.id, to: folder, above: versions.highest(it.id))
    let enc = B64.encode(sealed)
    _ = try masterKey() // locked meanwhile: nothing more is sent
    do {
      try await api.json("PUT", "/api/items/\(it.id)/meta", body: ["meta_enc": enc, "base": base])
    } catch let e as APIError where e.status == 400 {
      // a server from before bases refuses the unknown field: written as before
      try await api.json("PUT", "/api/items/\(it.id)/meta", body: ["meta_enc": enc])
    }
    versions.wrote(it.id, version, MetaHighWater.digest(enc))
    versions.flush()
    if folder == .locked { dropPictures(it.id) }
  }

  /** Removes an item's cached thumbnail and preview (ciphertext) from disk. */
  public func dropPictures(_ id: String) {
    guard Self.okId(id) else { return }
    dropCached("thumb-\(id)"); dropCached("preview-\(id)")
  }

  /** The library as last loaded, unsplit (the locked folder takes its items from it once its check passed). */
  public func currentLibrary() async -> [Item] { await librarySync.current() }

  public func setFavorite(_ ids: [String], _ on: Bool) async throws {
    for c in ids.chunked(500) { try await api.json("POST", "/api/items/favorite", body: ["item_ids": c, "favorite": on] as [String: Any]) }
  }

  // ---- albums: names encrypted under the master key, bound to the album id ----

  /** The albums, kept current with ?since (AlbumSync.swift): after the first load only the albums that changed. */
  public let albumSync = AlbumSync()

  public func loadAlbums() async throws -> [Album] {
    let m = try masterKey()
    return try await albumSync.load(get: { [api] in try await api.json("GET", $0) }, decrypt: { raw in
      raw.map { a in
        if let n = try? Crypto.decryptAlbumName(B64.decode(a.name_enc), master: m, albumId: a.id) { return Album(id: a.id, name: n, itemIds: a.item_ids, broken: false) }
        return Album(id: a.id, name: "Unreadable album", itemIds: a.item_ids, broken: true)
      }
    })
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
