// The album list, kept current with ?since like the library (ListSync.swift, server/albumsince.go): after the whole
// list, a change asks the server only for the albums that changed (each whole: name and photos) and the ids of those
// deleted, and decrypts only those names. The whole list loads again when the server says "reset", once a day, and
// always against a server that hands out no cursor. It lives in the Vault, which goes at every lock.
import Foundation

struct RawAlbum: Decodable, Sendable { let id: String; let name_enc: String; let created_at: Double?; let item_ids: [String] }

struct AlbumPage: Decodable {
  let albums: [RawAlbum]
  let cursor: String?
  let removed: [String]?
  let reset: Bool?
}

public actor AlbumSync {
  /** in the server's order: oldest album first */
  private var list: [Album]?
  private var created: [String: Double] = [:]
  private(set) var cursor: String?
  private var wholeAt: TimeInterval = 0
  private var busy = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  public init() {}

  func forget() { list = nil; created = [:]; cursor = nil; wholeAt = 0 }

  /** Brings the list up to date: only the changes when it can, else the whole list. One load at a time. */
  func load(get: @Sendable (String) async throws -> Data, decrypt: @Sendable ([RawAlbum]) throws -> [Album]) async throws -> [Album] {
    if busy { await withCheckedContinuation { waiting.append($0) } } else { busy = true }
    defer { if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() } }
    if let list, let cursor, Date().timeIntervalSince1970 - wholeAt < fullEvery {
      let chars = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "."))
      let p = try JSONDecoder().decode(AlbumPage.self, from: try await get("/api/albums?since=" + (cursor.addingPercentEncoding(withAllowedCharacters: chars) ?? cursor)))
      if p.reset != true, let next = p.cursor, let removed = p.removed {
        let out = merge(list, changed: try decrypt(p.albums), raw: p.albums, removed: removed)
        self.list = out; self.cursor = next
        return out
      }
    }
    let p = try JSONDecoder().decode(AlbumPage.self, from: try await get("/api/albums"))
    created = [:]
    let out = merge([], changed: try decrypt(p.albums), raw: p.albums, removed: [])
    list = out; cursor = p.cursor; wholeAt = Date().timeIntervalSince1970
    return out
  }

  /** Removed albums go, changed ones replace theirs or are added; then the server's order (created, then id). */
  private func merge(_ list: [Album], changed: [Album], raw: [RawAlbum], removed: [String]) -> [Album] {
    for r in raw { created[r.id] = r.created_at ?? 0 }
    for id in removed { created[id] = nil }
    var fresh = Dictionary(changed.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    let gone = Set(removed).subtracting(fresh.keys)
    var out: [Album] = []
    for a in list where !gone.contains(a.id) { out.append(fresh.removeValue(forKey: a.id) ?? a) }
    out += fresh.values
    return out.sorted { (created[$0.id] ?? 0, $0.id) < (created[$1.id] ?? 0, $1.id) }
  }
}
