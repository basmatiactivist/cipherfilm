// Incremental lists: the merge, and ListSync against a scripted server: one whole list, then only changes, decrypting
// only those; reset, paging, a kept copy, and a server without cursors.
import Foundation
import Testing
@testable import CipherfilmCore

private func item(_ id: String, _ when: Double, fav: Bool = false) -> Item {
  Item(id: id, kind: .image, size: 10, segmentCount: 1, createdAt: when, hasThumb: true, hasPreview: true, favorite: fav,
       trashedAt: nil, purgeAt: nil, meta: nil, itemKey: nil, broken: false)
}

private func raw(_ id: String, _ when: Double, fav: Bool = false) -> [String: Any] {
  ["id": id, "kind": "image", "size": 10, "segment_count": 1, "wrapped_item_key": "k", "meta_enc": "m", "has_thumb": true,
   "has_preview": true, "created_at": when, "favorite": fav]
}

/** A scripted server: each path answers in turn with its list of bodies (the last one again after that). */
private final class Script: @unchecked Sendable {
  private let lock = NSLock()
  private var answers: [String: [[String: Any]]]
  private(set) var asked: [String] = []
  private(set) var decrypted: [String] = []
  init(_ a: [String: [[String: Any]]]) { answers = a }

  func get(_ path: String) throws -> Data {
    try lock.withLock {
      asked.append(path)
      guard var list = answers[path], !list.isEmpty else { throw APIError(status: 404, message: "unexpected \(path)") }
      let body = list.count > 1 ? list.removeFirst() : list[0]
      answers[path] = list
      return try JSONSerialization.data(withJSONObject: body)
    }
  }

  func decrypt(_ raw: [RawItem]) -> [Item] {
    lock.withLock { decrypted += raw.map(\.id) }
    return raw.map { item($0.id, $0.created_at, fav: $0.favorite ?? false) }
  }
}

private func sync(_ s: Script, _ l: ListSync) async throws -> ListSync.Loaded {
  try await l.load(get: { try s.get($0) }, decrypt: { s.decrypt($0) })
}

private let newest: @Sendable (Item, Item) -> Bool = { $0.when > $1.when }

@Suite struct ListSyncTests {
  @Test func mergeAddsReplacesDropsAndNeverDoubles() {
    let base = [item("c", 3), item("b", 2), item("a", 1)]
    let out = ListSync.merge(base, changed: [item("d", 4), item("a", 1, fav: true), item("d", 4)], removed: ["b"], by: newest)
    #expect(out.map(\.id) == ["d", "c", "a"])
    #expect(out.last?.favorite == true)
    // removed and changed on one page: changed wins (trashed, then restored)
    #expect(ListSync.merge(base, changed: [item("a", 1)], removed: ["a"], by: newest).map(\.id) == ["c", "b", "a"])
  }

  @Test func wholeOnceThenOnlyTheChanges() async throws {
    let s = Script([
      "/api/items": [["items": [raw("a", 1), raw("b", 2)], "next": "x", "cursor": "e.5"]],
      "/api/items?after=x": [["items": [raw("c", 3)], "next": ""]],
      "/api/items?since=e.5": [["items": [raw("d", 4)], "removed": ["a"], "cursor": "e.7", "more": false]],
      "/api/items?since=e.7": [["items": [], "removed": [], "cursor": "e.7", "more": false]],
    ])
    let l = ListSync(path: "/api/items", order: newest)
    let first = try await sync(s, l)
    #expect(first.full && first.items.map(\.id) == ["c", "b", "a"])
    let second = try await sync(s, l)
    #expect(!second.full && second.changed && second.items.map(\.id) == ["d", "c", "b"])
    #expect(s.decrypted == ["a", "b", "c", "d"]) // d alone the second time
    let third = try await sync(s, l)
    #expect(!third.changed && third.items.map(\.id) == ["d", "c", "b"])
    #expect(s.asked.filter { $0 == "/api/items" }.count == 1)
    let kept = await l.kept()
    #expect(kept.cursor == "e.7" && Set(kept.records.map(\.id)) == ["b", "c", "d"])
  }

  @Test func pagesApplyInOrderAndResetLoadsWhole() async throws {
    let s = Script([
      "/api/items": [["items": [raw("a", 1)], "cursor": "e.1"], ["items": [raw("z", 9)], "cursor": "f.0"]],
      "/api/items?since=e.1": [["items": [raw("b", 2)], "removed": [], "cursor": "e.3", "more": true]],
      "/api/items?since=e.3": [["items": [], "removed": ["b"], "cursor": "e.4", "more": false]],
      "/api/items?since=e.4": [["items": [], "removed": [], "cursor": "e.9", "reset": true]],
    ])
    let l = ListSync(path: "/api/items", order: newest)
    _ = try await sync(s, l)
    #expect(try await sync(s, l).items.map(\.id) == ["a"]) // b came and was purged on the next page
    let r = try await sync(s, l)
    #expect(r.full && r.items.map(\.id) == ["z"])
  }

  @Test func aKeptCopyAsksOnlyForChangesAndCountsAsAChangeOnce() async throws {
    let s = Script(["/api/items?since=e.4": [["items": [], "removed": [], "cursor": "e.4", "more": false]]])
    let l = ListSync(path: "/api/items", order: newest)
    await l.seed([item("a", 1)], records: [], cursor: "e.4")
    let first = try await sync(s, l)
    #expect(!first.full && first.changed && first.items.map(\.id) == ["a"])
    #expect(try await sync(s, l).changed == false)
    #expect(s.asked == ["/api/items?since=e.4", "/api/items?since=e.4"])
  }

  @Test func aServerWithoutCursorsAlwaysSendsTheWholeList() async throws {
    let s = Script(["/api/items": [["items": [raw("a", 1)]], ["items": [raw("b", 2)]]]])
    let l = ListSync(path: "/api/items", order: newest)
    _ = try await sync(s, l)
    #expect(try await sync(s, l).items.map(\.id) == ["b"])
    await l.forget()
    _ = try await sync(s, l)
    #expect(s.asked == ["/api/items", "/api/items", "/api/items"])
  }

  @Test func pagesThatNeverEndAreStopped() async throws {
    let s = Script([
      "/api/items": [["items": [], "cursor": "e.1"]],
      "/api/items?since=e.1": [["items": [], "removed": [], "cursor": "e.1", "more": true]],
    ])
    let l = ListSync(path: "/api/items", order: newest)
    _ = try await sync(s, l)
    await #expect(throws: APIError.self) { try await sync(s, l) }
  }

  @Test func loadsRunOneAfterAnother() async throws {
    final class Count: @unchecked Sendable { let lock = NSLock(); var now = 0, most = 0 }
    let c = Count()
    let l = ListSync(path: "/api/items", order: newest)
    let get: @Sendable (String) async throws -> Data = { p in
      c.lock.withLock { c.now += 1; c.most = max(c.most, c.now) }
      try await Task.sleep(for: .milliseconds(5))
      c.lock.withLock { c.now -= 1 }
      let body: [String: Any] = p.contains("since") ? ["items": [], "removed": [], "cursor": "e.1", "more": false] : ["items": [raw("a", 1)], "cursor": "e.1"]
      return try JSONSerialization.data(withJSONObject: body)
    }
    try await withThrowingTaskGroup(of: Void.self) { g in
      for _ in 0..<4 { g.addTask { _ = try await l.load(get: get, decrypt: { $0.map { item($0.id, $0.created_at) } }) } }
      try await g.waitForAll()
    }
    #expect(c.most == 1)
  }
}
