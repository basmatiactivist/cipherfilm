// Archive and locked folder (docs/EDITING.md, "Archive and locked folder"): the Mac's copy of web/src/edit/folders.ts,
// with tests on the same cases (FoldersTests). Which folder an item is in is written INSIDE its encrypted metadata
// (`archived: true` or `locked: true`, through PUT /api/items/{id}/meta with the metadata version raised, as for every
// other change), so the server is never told which items are archived or locked: it sees that an item's metadata
// changed, and which thumbnails, previews and originals this Mac fetches. From those requests (opening the locked
// folder or an item in it, scrolling, what is fetched again after a restart, a trash followed at once by a purge) it
// can infer much of which items are locked, never what they show (docs/THREAT_MODEL.md, Archive and locked folder).
//
//   library  the main grid, On this day, search, albums, people, map, duplicates
//   archive  out of the main grid and On this day; still in search, albums, people, the map and favorites
//   locked   in the locked folder only, behind an extra check each time it opens; nowhere else (not even albums: the
//            album keeps the item, its views just don't show it, so moving it back out restores it there)
import Foundation

public enum Folder: String, Sendable, CaseIterable { case library, archive, locked }

public enum Folders {
  // ---- the rules, on the metadata as JSON (what is written) ----

  /** Only a literal JSON `true` counts: anything else a device reads (a string, a number) is "not set", never a guess.
   *  JSONSerialization hands numbers and booleans over as NSNumber, so `1 as? Bool` would say true: the CFBoolean
   *  type is checked instead. */
  public static func isTrue(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID() && n.boolValue
  }

  public static func isLocked(_ meta: [String: Any]?) -> Bool { isTrue(meta?["locked"]) }
  /** Archived and not locked (locked wins if both were ever written). */
  public static func isArchived(_ meta: [String: Any]?) -> Bool { isTrue(meta?["archived"]) && !isLocked(meta) }

  public static func folderOf(_ meta: [String: Any]?) -> Folder {
    isLocked(meta) ? .locked : isArchived(meta) ? .archive : .library
  }

  /** Drops flag values that aren't `true`. */
  public static func normFolders(_ meta: [String: Any]) -> [String: Any] {
    var m = meta
    if m["archived"] != nil && !isTrue(m["archived"]) { m.removeValue(forKey: "archived") }
    if m["locked"] != nil && !isTrue(m["locked"]) { m.removeValue(forKey: "locked") }
    return m
  }

  /** The metadata with the item moved to `to`: every other field (also ones this app doesn't know) is kept. */
  public static func withFolder(_ meta: [String: Any], _ to: Folder) -> [String: Any] {
    var m = meta
    m.removeValue(forKey: "archived")
    m.removeValue(forKey: "locked")
    if to == .archive { m["archived"] = true }
    if to == .locked { m["locked"] = true }
    return m
  }

  // ---- the metadata version (web/src/crypto/metaVersion.ts) ----

  /** The metadata's version: its `mv` when that is a whole number from 0 up to 2^53 - 1 (a safe integer), else 0. */
  public static func metaVersion(_ meta: [String: Any]) -> Int {
    guard let n = meta["mv"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return 0 }
    let d = n.doubleValue
    guard d.isFinite, d >= 0, d <= 9_007_199_254_740_991, d == d.rounded(.towardZero) else { return 0 }
    return Int(d)
  }

  /** The metadata as the next change writes it: the version one higher. */
  public static func nextVersion(_ meta: [String: Any]) -> [String: Any] {
    var m = meta
    m["mv"] = metaVersion(meta) + 1
    return m
  }

  // ---- the change ----

  /** The decrypted metadata JSON as the move writes it: read as a plain dictionary (never through ItemMeta, which
   *  knows only some fields), moved, the version raised (above `above` too: the highest version seen of the item). */
  public static func movedJSON(_ plain: Data, to: Folder, above: Int = 0) throws -> Data {
    try moved(plain, to: to, above: above).json
  }

  private static func moved(_ plain: Data, to: Folder, above: Int) throws -> (json: Data, version: Int) {
    guard let meta = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw CryptoError.failed("bad metadata") }
    var m = withFolder(meta, to)
    let v = max(metaVersion(meta), above) + 1
    m["mv"] = v
    return (try JSONSerialization.data(withJSONObject: m, options: [.withoutEscapingSlashes]), v)
  }

  /** The item's sealed metadata (meta_enc, as the server has it) moved to `to`, sealed again: what PUT
   *  /api/items/{id}/meta takes. Padded to 256 bytes like every metadata (Crypto.encryptMeta). */
  public static func resealed(_ metaEnc: Data, itemKey: Data, itemId: String, to: Folder) throws -> Data {
    try resealedVersion(metaEnc, itemKey: itemKey, itemId: itemId, to: to).sealed
  }

  /** resealed(), with the version it was written as. */
  public static func resealedVersion(_ metaEnc: Data, itemKey: Data, itemId: String, to: Folder, above: Int = 0) throws -> (sealed: Data, version: Int) {
    var plain = try Crypto.decryptMeta(metaEnc, itemKey: itemKey, itemId: itemId)
    defer { Sodium.memzero(&plain) }
    var (next, v) = try moved(plain, to: to, above: above)
    defer { Sodium.memzero(&next) }
    return (Crypto.encryptMeta(next, itemKey: itemKey, itemId: itemId), v)
  }

  // ---- decrypted items ----

  /** Splits a decrypted list: `open` is everything any view outside the locked folder may show (an unreadable item
   *  can't say where it is and stays with the library, shown as "couldn't be verified" as before), `locked` the rest.
   *  The app splits right after decrypting, so no other view is ever handed a locked item. */
  public static func splitLocked(_ items: [Item]) -> (open: [Item], locked: [Item]) {
    var open: [Item] = [], locked: [Item] = []
    for it in items { if !it.broken && it.isLocked { locked.append(it) } else { open.append(it) } }
    return (open, locked)
  }

  /** What the main grid and On this day show: neither archived nor locked. */
  public static func inMainGrid(_ it: Item) -> Bool { it.broken || it.folder == .library }
  public static func mainGrid(_ items: [Item]) -> [Item] { items.filter(inMainGrid) }
  /** The archive view: archived, not locked. */
  public static func archived(_ items: [Item]) -> [Item] { items.filter { !$0.broken && $0.isArchived } }
}

/** A metadata field that counts only when it is the JSON literal `true` (Folders.isTrue): any other value decodes as
 *  "not set" instead of making the whole item unreadable. */
public struct JSONTrue: Codable, Sendable, Hashable {
  public let value: Bool
  public init(_ value: Bool) { self.value = value }
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    value = (try? c.decode(Bool.self)) == true
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(value)
  }
}

public extension Item {
  /** In the locked folder, or handled as if: a stale item (its metadata is an older copy than this Mac has seen, so which
   *  folder it is really in isn't known) is shown in no open view, nothing of it is kept on disk, and nothing writes
   *  its metadata, until a copy at least as new as the one seen arrives. */
  var isLocked: Bool { stale || meta?.locked?.value == true }
  var isArchived: Bool { meta?.archived?.value == true && !isLocked }
  var folder: Folder { isLocked ? .locked : isArchived ? .archive : .library }
}
