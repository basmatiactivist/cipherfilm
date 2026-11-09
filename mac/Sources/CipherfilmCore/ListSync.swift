// Incremental lists: after the whole library (or trash) has loaded once, a live update asks the server only for what
// changed since (GET /api/items?since=<cursor>): new and changed records, the ids of those that left the list, and the
// next cursor. Only the changed records are decrypted; before, every ping decrypted the whole library again on all
// cores. The whole list loads again when the server says "reset" (its cursor is too old, or the database was
// restored), and always against a server that hands out no cursor. Same protocol as web/src/sync.ts.
import Foundation

struct ListPage: Decodable {
  let items: [RawItem]
  let next: String?
  let retention_days: Int?
  let cursor: String?
  let removed: [String]?
  let more: Bool?
  let reset: Bool?
}

/** Even with a cursor the whole list loads at least once a day: a safety net for anything the cursor can't see (a
 *  database put back by hand without a new epoch). Same as FULL_EVERY in web/src/sync.ts. */
public let fullEvery: TimeInterval = 24 * 60 * 60

public actor ListSync {
  public struct Loaded: Sendable {
    public let items: [Item]
    public let retentionDays: Int?
    /** a whole list (the first, or after a reset) */
    public let full: Bool
    /** something in the list is different from the last load */
    public let changed: Bool
  }

  let path: String
  let order: @Sendable (Item, Item) -> Bool
  private var list: [Item]?
  /** the server's records of the list, by id: what the cache keeps (the library's list.json) */
  private(set) var records: [String: RawItem] = [:]
  private(set) var cursor: String?
  private var gen = 0
  /** seeded from the cache and not loaded since: the first load counts as a change (the app's follow-ups, search
   *  and the watcher, haven't seen the list yet) */
  private var seeded = false
  /** when the whole list last loaded (or the kept copy did), seconds since 1970 */
  private(set) var wholeAt: TimeInterval = 0
  private var busy = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  init(path: String, order: @escaping @Sendable (Item, Item) -> Bool) { self.path = path; self.order = order }

  /** Starts from a kept copy and its cursor, if nothing was loaded yet: the first load then asks only for changes. */
  func seed(_ items: [Item], records: [RawItem], cursor: String?, wholeAt: TimeInterval = 0) {
    guard list == nil else { return }
    self.wholeAt = wholeAt
    list = items.sorted(by: order)
    self.records = Dictionary(records.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    self.cursor = cursor
    seeded = true
  }

  /** The records and the cursor they are current to, taken together. */
  func kept() -> (records: [RawItem], cursor: String?, wholeAt: TimeInterval) { (Array(records.values), cursor, wholeAt) }

  func forget() { list = nil; records = [:]; cursor = nil; seeded = false; wholeAt = 0; gen += 1 }

  /** Brings the list up to date; loads run one after another (a load during another may have missed its change). */
  func load(get: @Sendable (String) async throws -> Data, decrypt: @Sendable ([RawItem]) throws -> [Item]) async throws -> Loaded {
    await acquire()
    defer { release() }
    let g = gen
    if let list, let cursor, Date().timeIntervalSince1970 - wholeAt < fullEvery, let r = try await changes(list, cursor, g, get, decrypt) { return r }
    return try await whole(g, get, decrypt)
  }

  private func acquire() async {
    if !busy { busy = true; return }
    await withCheckedContinuation { waiting.append($0) }
  }

  private func release() {
    if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
  }

  private func page(_ q: String, _ get: @Sendable (String) async throws -> Data) async throws -> ListPage {
    try JSONDecoder().decode(ListPage.self, from: try await get(path + q))
  }

  private func whole(_ g: Int, _ get: @Sendable (String) async throws -> Data, _ decrypt: @Sendable ([RawItem]) throws -> [Item]) async throws -> Loaded {
    let first = try await page("", get)
    var raw = first.items, next = first.next ?? "", pages = 1
    var days = first.retention_days
    while !next.isEmpty {
      let p = try await page("?after=" + (next.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? next), get)
      raw += p.items
      days = p.retention_days ?? days
      pages += 1
      guard pages <= Vault.maxListPages, raw.count <= Vault.maxListItems, p.next != next else { throw APIError(status: -1, message: "The server's list doesn't end.") }
      next = p.next ?? ""
    }
    raw = Self.unique(raw)
    let items = try decrypt(raw).sorted(by: order)
    // the first page's cursor: what changed while the later pages loaded comes with the next ?since
    if g == gen {
      seeded = false
      list = items
      records = Dictionary(raw.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
      cursor = first.cursor
      wholeAt = Date().timeIntervalSince1970
    }
    return Loaded(items: items, retentionDays: days, full: true, changed: true)
  }

  /** nil: the server wants the whole list again */
  private func changes(_ start: [Item], _ from: String, _ g: Int, _ get: @Sendable (String) async throws -> Data,
                       _ decrypt: @Sendable ([RawItem]) throws -> [Item]) async throws -> Loaded? {
    var list = start, recs = records, cur = from, pages = 0, changed = false
    var days: Int?
    while true {
      let p = try await page("?since=" + (cur.addingPercentEncoding(withAllowedCharacters: Self.cursorChars) ?? cur), get)
      if p.reset == true { return nil }
      guard let next = p.cursor, let removed = p.removed else { return nil } // not an answer to ?since
      days = p.retention_days ?? days
      if !p.items.isEmpty || removed.contains(where: { recs[$0] != nil }) {
        list = Self.merge(list, changed: p.items.isEmpty ? [] : try decrypt(p.items), removed: removed, by: order)
        for id in removed { recs[id] = nil }
        for x in p.items { recs[x.id] = x }
        changed = true
      }
      pages += 1
      guard p.more == true else { cur = next; break }
      guard next != cur, pages <= Vault.maxListPages else { throw APIError(status: -1, message: "The server's list doesn't end.") }
      cur = next
    }
    if g == gen { self.list = list; records = recs; cursor = cur }
    defer { seeded = false }
    return Loaded(items: list, retentionDays: days, full: false, changed: changed || seeded)
  }

  /** One record per id (the last one sent, as in `records`), in the order they came: an id twice would show twice. */
  static func unique(_ raw: [RawItem]) -> [RawItem] {
    var last: [String: Int] = [:]
    for (i, x) in raw.enumerated() { last[x.id] = i }
    guard last.count < raw.count else { return raw }
    return raw.enumerated().filter { last[$0.element.id] == $0.offset }.map(\.element)
  }

  /** a cursor is "<epoch>.<number>": sent as it is */
  private static let cursorChars = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "."))

  /** Applies one page of changes: removed ids go, changed items replace theirs or are added (by id: this Mac's own
   *  uploads never show twice), then the order is restored. */
  public static func merge(_ list: [Item], changed: [Item], removed: [String], by order: (Item, Item) -> Bool) -> [Item] {
    var gone = Set(removed)
    var fresh: [String: Item] = [:]
    for it in changed { fresh[it.id] = it; gone.remove(it.id) }
    var out: [Item] = []
    out.reserveCapacity(list.count + fresh.count)
    for it in list where !gone.contains(it.id) {
      if let f = fresh.removeValue(forKey: it.id) { out.append(f) } else { out.append(it) }
    }
    out += fresh.values
    return out.sorted(by: order)
  }
}
