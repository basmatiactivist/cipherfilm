// Importing a WebDAV folder into the library (docs/MAC.md "Import from a WebDAV folder"): which files are new, the
// bookkeeping that makes an interrupted import go on where it stopped, and the upload of one file streamed from the
// server through the same encryption, thumbnails and metadata as a local file. Disk: nothing for photos up to
// `memoryLimit` and videos (read by Range requests, segment by segment); only a larger photo, or any file from a server
// that sends no parts, is fetched into the app's own caches first and deleted right after.
import Foundation

public enum WebDAVImport {
  /** The types the upload tool takes (tools/upload/media.go). */
  public static let types: [String: String] = [
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
    "heic": "image/heic", "heif": "image/heif", "gif": "image/gif", "dng": "image/x-adobe-dng",
    "mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v",
  ]
  /** A photo up to this size is read into memory (it is decoded whole for its thumbnail anyway); larger ones go through
   *  a temporary file. */
  public static let memoryLimit: Int64 = 48 << 20
  /** What AVFoundation may read of a video for its frame and metadata. */
  public static let videoProbeBudget: Int64 = 64 << 20
  public static let defaultParallel = 3

  public static func mime(for name: String) -> String? { types[(name as NSString).pathExtension.lowercased()] }

  public struct Plan: Sendable, Equatable {
    /** to upload, oldest first */
    public var todo: [WebDAVEntry]
    public var bytes: Int64
    /** imported before (this source's bookkeeping) */
    public var done: Int
    /** already in the library (same name and size), not imported again */
    public var inLibrary: Int
    /** given up after three tries (Retry in Settings tries them again) */
    public var failed: Int
    /** not a photo or video type the app takes */
    public var unsupported: [String]
    public var folders: Int
    public var files: Int
  }

  /** What a pass has to do. known: the library's fingerprints (name and size, Crypto.fingerprint). */
  public static func plan(_ l: WebDAVListing, book: ImportBook, known: Set<String>) -> Plan {
    var p = Plan(todo: [], bytes: 0, done: 0, inLibrary: 0, failed: 0, unsupported: [], folders: l.folders, files: l.files.count)
    for e in l.files {
      guard mime(for: e.name) != nil else { p.unsupported.append(e.name); continue }
      if let m = book.mark(e) { if m.skipped != nil { p.failed += 1 } else { p.done += 1 }; continue }
      if known.contains(Crypto.fingerprint(name: e.name, size: e.size)) { p.inLibrary += 1; continue }
      p.todo.append(e); p.bytes += e.size
    }
    p.todo.sort { ($0.modified ?? .distantPast, $0.name) < ($1.modified ?? .distantPast, $1.name) }
    return p
  }

  public enum Event: Sendable {
    case started(String, size: Int64)
    /** bytes uploaded since the last event of this file */
    case bytes(Int64)
    case uploaded(String, id: String)
    case failed(String, String, gaveUp: Bool)
  }

  /** Whether an error is about the way to a server (this pass ends, nothing counts against the file). */
  public static func transient(_ e: Error) -> Bool {
    if e is Stopped || e is CancellationError { return true }
    if let w = e as? WebDAVError { return w.transient }
    if let a = e as? APIError { return a.status == 0 || a.status == 401 || a.status == 408 || a.status == 413 || a.status == 429 || a.status >= 500 }
    return false
  }

  /** Uploads the files, `parallel` at a time, recording each in the book as it is done. Throws what ended the pass
   *  early (Stopped, or a server that can't be reached); a file's own problem is counted against it instead. */
  public static func run(_ todo: [WebDAVEntry], client: WebDAVClient, api: API, wrap: Uploader.Wrap, book: ImportBook,
                         parallel: Int = defaultParallel, temp: URL, budget: DiskBudget? = nil, live: @escaping @Sendable () throws -> Void,
                         event: @escaping @Sendable (Event) -> Void) async throws {
    let budget = budget ?? DiskBudget(temp: temp)
    try await withThrowingTaskGroup(of: Void.self) { g in
      var running = 0
      for e in todo {
        if running >= max(1, parallel) { try await g.next(); running -= 1 }
        try live()
        g.addTask {
          event(.started(e.name, size: e.size))
          let last = Counter()
          do {
            let id = try await upload(e, client: client, api: api, wrap: wrap, temp: temp, budget: budget, live: live) { done, _ in
              let before = last.value
              if done > before { last.add(done - before); event(.bytes(done - before)) }
            }
            book.markDone(e)
            event(.uploaded(e.name, id: id))
          } catch {
            if transient(error) { throw error }
            try live() // stopped meanwhile: not the file's fault
            let gaveUp = book.failed(e, error.localizedDescription)
            event(.failed(e.name, error.localizedDescription, gaveUp: gaveUp))
          }
        }
        running += 1
      }
      try await g.waitForAll()
    }
  }

  /** Uploads one file of the folder; resolves with the new item's id. */
  public static func upload(_ e: WebDAVEntry, client: WebDAVClient, api: API, wrap: Uploader.Wrap, temp: URL, budget: DiskBudget? = nil,
                            live: @escaping @Sendable () throws -> Void = {},
                            progress: @escaping @Sendable (Int64, Int64) -> Void = { _, _ in }) async throws -> String {
    guard let mime = mime(for: e.name) else { throw APIError(status: -1, message: "This type of file isn't imported.") }
    guard e.size <= Media.maxFile else { throw APIError(status: -1, message: "Files over 8 GB can't be uploaded.") }
    let video = Media.kind(name: e.name, mime: mime) == .video
    // the server's modification time stands in for the capture time when the file's own metadata has none
    let modified = e.modified ?? Date()
    do {
      // a server that only sends whole files is found out before a large one is read whole into memory
      if e.size > Int64(Segments.plain), try await !client.sendsRanges(e) { throw WebDAVError.noRanges }
      if video { return try await ranged(e, mime: mime, modified: modified, client: client, api: api, wrap: wrap, live: live, progress: progress) }
      if e.size <= memoryLimit { return try await inMemory(e, mime: mime, modified: modified, client: client, api: api, wrap: wrap, live: live, progress: progress) }
    } catch WebDAVError.noRanges {
      // a server that only sends whole files: through a temporary file below
    }
    // the temporary copies of all files in flight together stay within the budget, and never fill the disk
    let budget = budget ?? DiskBudget(temp: temp)
    try await budget.acquire(e.size, live: live)
    defer { budget.release(e.size) }
    return try await viaFile(e, modified: modified, client: client, api: api, wrap: wrap, temp: temp, live: live, progress: progress)
  }

  /** A photo: read once into memory, decoded from there for its thumbnails and metadata, encrypted from there. */
  static func inMemory(_ e: WebDAVEntry, mime: String, modified: Date, client: WebDAVClient, api: API, wrap: Uploader.Wrap,
                       live: @escaping @Sendable () throws -> Void, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> String {
    var data = Data(capacity: Int(e.size))
    var o: Int64 = 0
    while o < e.size {
      try live()
      let n = Int(min(Int64(Segments.plain), e.size - o))
      data.append(try await client.read(e, offset: o, len: n))
      o += Int64(n)
    }
    let d = data
    let src = Uploader.Source(name: e.name, mime: mime, size: e.size, modified: modified, read: { o, n in
      guard o >= 0, Int(o) + n <= d.count else { return Data() }
      return d.subdata(in: Int(o)..<Int(o) + n)
    }, pictures: {
      Uploader.Pictures(thumb: Media.jpeg(data: d, maxPx: Media.thumbPx, quality: 0.82), preview: Media.jpeg(data: d, maxPx: Media.previewPx, quality: 0.85))
    }, info: { Media.info(data: d) })
    return try await Uploader.upload(src, api: api, wrap: wrap, live: live, progress: progress)
  }

  /** A video: its segments read by Range requests as they are encrypted; its frame and metadata through RangedAsset. */
  static func ranged(_ e: WebDAVEntry, mime: String, modified: Date, client: WebDAVClient, api: API, wrap: Uploader.Wrap,
                     live: @escaping @Sendable () throws -> Void, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> String {
    let read: @Sendable (Int64, Int) async throws -> Data = { o, n in try await client.read(e, offset: o, len: n) }
    let probe = RangedAsset(name: e.name, size: e.size, budget: videoProbeBudget, read: read)
    defer { probe.cancel() }
    let src = Uploader.Source(name: e.name, mime: mime, size: e.size, modified: modified, read: read, pictures: {
      // one frame, fetched once: the thumbnail is made from the preview
      guard let p = await Media.jpeg(asset: probe.asset, maxPx: Media.previewPx, quality: 0.85) else { return nil }
      return Uploader.Pictures(thumb: Media.jpeg(data: p.data, maxPx: Media.thumbPx, quality: 0.82), preview: p)
    }, info: {
      await Media.info(asset: probe.asset, location: { await Media.remoteVideoLocation(size: e.size, read: read) })
    })
    return try await Uploader.upload(src, api: api, wrap: wrap, live: live, progress: progress)
  }

  /** Into a file of the app's own caches (a private folder of its own per file), uploaded like a local file, deleted
   *  right after, also when the upload fails. */
  static func viaFile(_ e: WebDAVEntry, modified: Date, client: WebDAVClient, api: API, wrap: Uploader.Wrap, temp: URL,
                      live: @escaping @Sendable () throws -> Void, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> String {
    let fm = FileManager.default
    let dir = temp.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(at: dir) }
    let f = dir.appendingPathComponent(e.name) // a single path component (PropFind.parse)
    try live()
    do {
      guard fm.createFile(atPath: f.path, contents: nil, attributes: [.posixPermissions: 0o600]), let h = try? FileHandle(forWritingTo: f) else {
        throw APIError(status: -1, message: "No room for a temporary copy.")
      }
      defer { try? h.close() }
      var o: Int64 = 0
      while o < e.size {
        try live()
        let n = Int(min(Int64(Segments.plain), e.size - o))
        try h.write(contentsOf: try await client.read(e, offset: o, len: n))
        o += Int64(n)
      }
    } catch WebDAVError.noRanges {
      try await client.download(e, to: f)
    }
    try fm.setAttributes([.modificationDate: modified], ofItemAtPath: f.path)
    return try await Uploader.upload(f, api: api, wrap: wrap, live: live, progress: progress)
  }
}

/** How much the temporary copies (WebDAVImport.viaFile) may take at once: files take turns once together they would
 *  pass `limit` (4 GB, or a tenth of the free space when that is less), but one file always may, whatever its size, so
 *  a video of any size still imports. Before each copy the disk must keep `margin` free after it; otherwise the pass
 *  stops with WebDAVError.diskFull rather than filling the disk. Streamed files (photos up to 48 MB, videos from a
 *  server that sends parts of files) take nothing from it. */
public final class DiskBudget: @unchecked Sendable {
  public let limit: Int64
  public let margin: Int64
  private let free: @Sendable () -> Int64?
  private let lock = NSLock()
  private var used: Int64 = 0

  public static func freeSpace(_ url: URL) -> Int64? {
    var u = url
    while !FileManager.default.fileExists(atPath: u.path), u.pathComponents.count > 1 { u = u.deletingLastPathComponent() }
    return (try? u.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
  }

  public convenience init(temp: URL) {
    let f = Self.freeSpace(temp)
    self.init(limit: min(4 << 30, max(256 << 20, (f ?? 0) / 10)), margin: 2 << 30, free: { Self.freeSpace(temp) })
  }

  /** free: the free space now (nil: unknown, then only the limit counts). */
  public init(limit: Int64, margin: Int64, free: @escaping @Sendable () -> Int64?) {
    self.limit = limit; self.margin = margin; self.free = free
  }

  public var inUse: Int64 { lock.withLock { used } }

  /** Waits until `n` bytes fit (or nothing else is held), then reserves them. */
  public func acquire(_ n: Int64, live: @Sendable () throws -> Void = {}) async throws {
    while true {
      try live()
      try Task.checkCancellation()
      let got: Bool = try lock.withLock {
        guard used == 0 || used + n <= limit else { return false }
        // the space the other copies reserved may not be written yet: counted as gone already
        if let f = free(), f - (used) < n + margin { throw WebDAVError.diskFull }
        used += n
        return true
      }
      if got { return }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
  }

  public func release(_ n: Int64) { lock.withLock { used = max(0, used - n) } }
}

/** What a source imported: per file name its size, ETag and modification time, so an interrupted or repeated import
 *  goes on where it stopped and never uploads a file twice. Kept as an append-only log (one JSON line per change, in
 *  the account's folder), so recording a file costs one small write however large the folder; compacted when loaded. */
public final class ImportBook: @unchecked Sendable {
  public struct Mark: Codable, Equatable, Sendable {
    public var size: Int64
    public var etag: String?
    /** ms since 1970 */
    public var modified: Double?
    /** given up after three failures: why */
    public var skipped: String?
  }

  struct Line: Codable {
    var op: String // "d" done, "x" given up, "f" failed once, "r" try again
    var n: String
    var s: Int64?
    var e: String?
    var m: Double?
    var why: String?
  }

  public let file: URL?
  private let lock = NSLock()
  private var marks: [String: Mark] = [:]
  private var failures: [String: Int] = [:]
  private var handle: FileHandle?
  private var lines = 0
  public static let tries = 3

  /** file: nil keeps it in memory (tests). */
  public init(file: URL?) {
    self.file = file
    guard let file, let d = try? Data(contentsOf: file) else { return }
    for raw in d.split(separator: UInt8(ascii: "\n")) {
      guard let l = try? JSONDecoder().decode(Line.self, from: raw) else { continue } // a line cut short by a crash
      apply(l)
      lines += 1
    }
    if lines > 2 * (marks.count + failures.count) + 64 { compact() }
  }

  deinit { try? handle?.close() }

  private func apply(_ l: Line) {
    switch l.op {
    case "d", "x":
      marks[l.n] = Mark(size: l.s ?? 0, etag: l.e, modified: l.m, skipped: l.op == "x" ? (l.why ?? "") : nil)
      failures.removeValue(forKey: l.n)
    case "f": failures[l.n, default: 0] += 1
    case "r":
      if marks[l.n]?.skipped != nil { marks.removeValue(forKey: l.n) }
      failures.removeValue(forKey: l.n)
    default: break
    }
  }

  private func append(_ l: Line) {
    apply(l)
    guard let file, var d = try? JSONEncoder().encode(l) else { return }
    d.append(UInt8(ascii: "\n"))
    if handle == nil {
      let fm = FileManager.default
      try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
      handle = try? FileHandle(forUpdating: file)
      // after a line cut short by a crash the next one starts on a line of its own
      if let h = handle, let end = try? h.seekToEnd(), end > 0, (try? h.seek(toOffset: end - 1)) != nil,
         let last = try? h.read(upToCount: 1), last != Data([UInt8(ascii: "\n")]) {
        _ = try? h.seekToEnd()
        try? h.write(contentsOf: Data([UInt8(ascii: "\n")]))
      }
      _ = try? handle?.seekToEnd()
    }
    try? handle?.write(contentsOf: d)
    lines += 1
  }

  static func ms(_ d: Date?) -> Double? { d.map { ($0.timeIntervalSince1970 * 1000).rounded() } }

  /** The file's mark when it is this version of it: same size, and the same ETag or modification time where both
   *  sides know one. A file replaced by another of the same name counts as new. */
  public func mark(_ e: WebDAVEntry) -> Mark? {
    lock.withLock {
      guard let m = marks[e.name], m.size == e.size else { return nil }
      if let a = m.etag, let b = e.etag, a == b { return m }
      if let a = m.modified, let b = Self.ms(e.modified), a == b { return m }
      return (m.etag == nil || e.etag == nil) && (m.modified == nil || e.modified == nil) ? m : nil
    }
  }

  public func isDone(_ e: WebDAVEntry) -> Bool { mark(e) != nil }

  public func markDone(_ e: WebDAVEntry) {
    lock.withLock { append(Line(op: "d", n: e.name, s: e.size, e: e.etag, m: Self.ms(e.modified))) }
  }

  /** Counts a failure; true when this was the last try and the file is now left out. */
  @discardableResult
  public func failed(_ e: WebDAVEntry, _ why: String) -> Bool {
    lock.withLock {
      if failures[e.name, default: 0] + 1 >= Self.tries {
        append(Line(op: "x", n: e.name, s: e.size, e: e.etag, m: Self.ms(e.modified), why: String(why.prefix(200))))
        return true
      }
      append(Line(op: "f", n: e.name))
      return false
    }
  }

  /** The files given up on, with why. */
  public var givenUp: [(name: String, why: String)] {
    lock.withLock { marks.compactMap { k, m in m.skipped.map { (k, $0) } }.sorted { $0.name < $1.name } }
  }

  public var doneCount: Int { lock.withLock { marks.values.filter { $0.skipped == nil }.count } }

  /** Retry: the files given up on are tried again at the next pass. */
  public func retryGivenUp() {
    lock.withLock { for (k, m) in marks where m.skipped != nil { append(Line(op: "r", n: k)) } }
  }

  /** Everything this pass's folder listing has as done (the "only new files" start). */
  public func baseline(_ files: [WebDAVEntry]) {
    lock.withLock { for e in files where marks[e.name] == nil { append(Line(op: "d", n: e.name, s: e.size, e: e.etag, m: Self.ms(e.modified))) } }
  }

  /** Rewrites the log with one line per file. */
  public func compact() {
    lock.withLock {
      guard let file else { return }
      var out = Data()
      let enc = JSONEncoder()
      for (k, m) in marks.sorted(by: { $0.key < $1.key }) {
        if let d = try? enc.encode(Line(op: m.skipped == nil ? "d" : "x", n: k, s: m.size, e: m.etag, m: m.modified, why: m.skipped)) { out.append(d); out.append(UInt8(ascii: "\n")) }
      }
      for (k, n) in failures.sorted(by: { $0.key < $1.key }) {
        for _ in 0..<n { if let d = try? enc.encode(Line(op: "f", n: k)) { out.append(d); out.append(UInt8(ascii: "\n")) } }
      }
      try? handle?.close(); handle = nil
      if (try? out.write(to: file, options: .atomic)) != nil { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
      lines = marks.count + failures.values.reduce(0, +)
    }
  }
}
