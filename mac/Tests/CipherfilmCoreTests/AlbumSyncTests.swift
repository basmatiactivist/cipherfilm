// The album list kept current with ?since: the whole list once, then only the albums that changed (each whole) and
// the ids of those deleted, decrypting only those; a reset and a server without cursors load the whole list.
import Foundation
import Testing
@testable import CipherfilmCore

private final class AlbumScript: @unchecked Sendable {
  private let lock = NSLock()
  var answers: [String: [String: Any]]
  private(set) var asked: [String] = []
  private(set) var decrypted: [String] = []
  init(_ a: [String: [String: Any]]) { answers = a }

  func get(_ path: String) throws -> Data {
    try lock.withLock {
      asked.append(path)
      guard let body = answers[path] else { throw APIError(status: 404, message: "unexpected \(path)") }
      return try JSONSerialization.data(withJSONObject: body)
    }
  }

  func decrypt(_ raw: [RawAlbum]) -> [Album] {
    lock.withLock { decrypted += raw.map(\.id) }
    return raw.map { Album(id: $0.id, name: "name " + $0.name_enc, itemIds: $0.item_ids, broken: false) }
  }

  func reset() { lock.withLock { asked = []; decrypted = [] } }
}

private func album(_ id: String, _ name: String, _ created: Int, _ items: [String] = []) -> [String: Any] {
  ["id": id, "name_enc": name, "created_at": created, "item_ids": items]
}

private func load(_ s: AlbumScript, _ a: AlbumSync) async throws -> [Album] {
  try await a.load(get: { try s.get($0) }, decrypt: { s.decrypt($0) })
}

@Suite struct AlbumSyncTests {
  let e = "0123456789abcdef"

  @Test func wholeOnceThenOnlyTheChanges() async throws {
    let s = AlbumScript(["/api/albums": ["albums": [album("a", "A", 1, ["x"]), album("b", "B", 2), album("c", "C", 3)], "cursor": "\(e).5"]])
    let sync = AlbumSync()
    #expect(try await load(s, sync).map(\.id) == ["a", "b", "c"])
    s.reset()
    s.answers["/api/albums?since=\(e).5"] = ["albums": [album("d", "D", 0), album("b", "B2", 2, ["x", "y"])], "removed": ["a"], "cursor": "\(e).9", "more": false, "reset": false]
    let next = try await load(s, sync)
    #expect(s.asked == ["/api/albums?since=\(e).5"])
    #expect(s.decrypted.sorted() == ["b", "d"])
    #expect(next.map(\.id) == ["d", "b", "c"]) // the server's order: oldest first
    #expect(next[1].name == "name B2" && next[1].itemIds == ["x", "y"])
    s.reset()
    s.answers["/api/albums?since=\(e).9"] = ["albums": [], "removed": [], "cursor": "\(e).9", "more": false, "reset": false]
    #expect(try await load(s, sync) == next)
    #expect(s.decrypted.isEmpty)
  }

  @Test func resetAndServersWithoutCursorsLoadWhole() async throws {
    let s = AlbumScript(["/api/albums": ["albums": [album("a", "A", 1)], "cursor": "\(e).5"],
                         "/api/albums?since=\(e).5": ["albums": [], "removed": [], "cursor": "\(e).7", "reset": true]])
    let sync = AlbumSync()
    _ = try await load(s, sync)
    s.reset()
    _ = try await load(s, sync)
    #expect(s.asked == ["/api/albums?since=\(e).5", "/api/albums"])

    let old = AlbumScript(["/api/albums": ["albums": [album("a", "A", 1)]]])
    let sync2 = AlbumSync()
    _ = try await load(old, sync2)
    _ = try await load(old, sync2)
    #expect(old.asked == ["/api/albums", "/api/albums"])
  }
}
