// The metadata versions this Mac has seen (docs/CRYPTO.md, "Metadata version"): the Mac's copy of the HighWater in
// web/src/crypto/metaVersion.ts, with tests on the same cases (MetaVersionTests). Every change of an item's metadata
// raises its `mv` by one; the server can't change it (the metadata is sealed) but could hand out an older sealed copy
// it kept, to bring back a removed place or take an item out of the locked folder. This Mac remembers the highest
// version seen of each item, and which sealed copy that was, and never goes back: in a session it keeps the newer
// metadata; after a restart (when only the number is known) the item is stale, and a stale item is handled as a locked
// one (Item.isLocked): no open view shows it, nothing of it is kept on disk, and nothing writes its metadata.
import CryptoKit
import Foundation

/** The metadata's `mv` as decoded with ItemMeta: a whole number from 0 up to 2^53 - 1; anything else (a string, a
 *  fraction, `true`) counts as 0 instead of making the item unreadable (Folders.metaVersion). */
public struct MetaVersionNumber: Codable, Sendable, Hashable {
  public let value: Int
  public init(_ value: Int) { self.value = value }
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if (try? c.decode(Bool.self)) != nil { value = 0; return }
    guard let d = try? c.decode(Double.self), d.isFinite, d >= 0, d <= 9_007_199_254_740_991, d == d.rounded(.towardZero) else { value = 0; return }
    value = Int(d)
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(value)
  }
}

public final class MetaHighWater: @unchecked Sendable {
  /** How many items' versions are kept (those above 0 only). Nothing is ever dropped to make room: when it is full, a
   *  further item's metadata can't be checked and is handled as stale. */
  public static let keepVersions = 50_000

  private let lock = NSLock()
  private var seen: [String: (v: Int, d: String?)] = [:]
  private var dirty = false
  private let file: URL?
  private let max: Int

  /** file: where they are kept across restarts (nil: this run only). */
  public init(file: URL?, max: Int = MetaHighWater.keepVersions) {
    self.file = file
    self.max = max
    guard let file, let d = try? Data(contentsOf: file), let list = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return }
    for e in list {
      guard let a = e as? [Any], a.count >= 2, let id = a[0] as? String, ServerId.valid(id), let n = a[1] as? NSNumber,
            CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 1, n.doubleValue <= 9_007_199_254_740_991, n.doubleValue == n.doubleValue.rounded(.towardZero) else { continue }
      seen[id] = (n.intValue, a.count > 2 ? Self.short(a[2] as? String) : nil)
    }
  }

  /** Which sealed copy of the metadata this is: the SHA-256 (hex) of its meta_enc as the server lists it. A change
   *  sends it as its `base` (PUT /api/items/{id}/meta), so the server refuses it when the item changed meanwhile. */
  public static func digest(_ metaEnc: String) -> String {
    SHA256.hash(data: Data(metaEnc.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /** What is kept of a digest: 64 bits tell two sealed copies apart (the server can't choose either's bytes). */
  private static func short(_ d: String?) -> String? {
    guard let d, (16...64).contains(d.utf8.count), d.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else { return nil }
    return String(d.prefix(16))
  }

  /** The highest version seen of an item; 0 when none above 0. */
  public func highest(_ id: String) -> Int { lock.withLock { seen[id]?.v ?? 0 } }

  /** Whether this copy may be shown, without noting it: false for an older version than one seen (a replay), for
   *  another copy at the version seen (two changes made from the same older copy), and for an item not seen before
   *  once the store is full (it can't be checked). */
  public func accepts(_ id: String, _ version: Int, _ digest: String?) -> Bool { lock.withLock { acceptsLocked(id, version, digest) } }

  private func acceptsLocked(_ id: String, _ version: Int, _ digest: String?) -> Bool {
    guard let was = seen[id] else { return version == 0 || seen.count < max }
    if version < was.v { return false }
    if version == was.v, let d = Self.short(digest), let k = was.d, d != k { return false }
    return true
  }

  /** accepts(), and notes the copy when it is accepted. */
  public func check(_ id: String, _ version: Int, _ digest: String?) -> Bool {
    lock.withLock {
      guard acceptsLocked(id, version, digest) else { return false }
      note(id, version, digest)
      return true
    }
  }

  /** This Mac wrote this copy itself (it is the newest it knows). */
  public func wrote(_ id: String, _ version: Int, _ digest: String) {
    lock.withLock { if acceptsLocked(id, version, digest) { note(id, version, digest) } }
  }

  private func note(_ id: String, _ version: Int, _ digest: String?) {
    guard version > 0 else { return }
    let d = Self.short(digest)
    if let was = seen[id], was.v == version, was.d != nil || d == nil { return }
    seen[id] = (version, d)
    dirty = true
  }

  /** Writes what changed since the last flush (after a list was decrypted): item ids, numbers and digests only. */
  public func flush() {
    let list: [[Any]]? = lock.withLock {
      guard dirty else { return nil }
      dirty = false
      return seen.map { id, e in e.d.map { [id, e.v, $0] } ?? [id, e.v] }
    }
    guard let list, let file, let d = try? JSONSerialization.data(withJSONObject: list) else { return }
    let fm = FileManager.default
    try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if (try? d.write(to: file, options: .atomic)) != nil { try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
  }

  // ---- where they are kept ----

  /** The folder of every account's versions on this Mac. It stays over locks and sessions the server ended (a plain
   *  expiry, a sign-out from another device): otherwise a server could make this Mac forget which versions it saw just
   *  by ending the session. Only the person's own sign-out, deleting the account or leaving the server deletes it. */
  public static func root() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/cf-mv", isDirectory: true)
  }

  /** An account's file; nil for an id that isn't one (an id from the server becomes a path only this way). */
  public static func file(for userId: String, in dir: URL = root()) -> URL? {
    ServerId.valid(userId) ? dir.appendingPathComponent("\(userId).json") : nil
  }

  /** The person signed out here, deleted the account or left the server. */
  public static func forgetAll(in dir: URL = root()) { try? FileManager.default.removeItem(at: dir) }
}
