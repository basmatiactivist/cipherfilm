// Signing out unused devices (server/sessions.go idleLimit) and this Mac's last upload time, as the app reads and sends them.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct DeviceIdleTests {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func device(_ id: String, current: Bool = false, daysAgo: Int64) throws -> Device {
    let d: [String: Any] = ["id": id, "device": "", "created_at": 0, "last_seen": 1_800_000_000 - daysAgo * 86400, "current": current, "indexer": false]
    return try JSONDecoder().decode(Device.self, from: JSONSerialization.data(withJSONObject: d))
  }

  @Test func choiceOr30Days() {
    #expect(DeviceIdle.days(7) == 7)
    #expect(DeviceIdle.days(14) == 14)
    #expect(DeviceIdle.days(30) == 30)
    #expect(DeviceIdle.days(nil) == 30)
    #expect(DeviceIdle.days(10) == 30)
  }

  @Test func unusedAreOtherDevicesBeyondTheLimit() throws {
    let list = [try device("this", current: true, daysAgo: 40), try device("a", daysAgo: 8), try device("b", daysAgo: 7), try device("c", daysAgo: 20)]
    #expect(DeviceIdle.unused(list, days: 7, now: now).map(\.id) == ["a", "c"])
    #expect(DeviceIdle.unused(list, days: 14, now: now).map(\.id) == ["c"])
    #expect(DeviceIdle.unused(list, days: 30, now: now).isEmpty)
  }

  private func item(_ id: String, name: String, size: Int64, at: Double) -> Item {
    Item(id: id, kind: .image, size: 1, segmentCount: 1, createdAt: at, hasThumb: false, hasPreview: false, favorite: false,
         trashedAt: nil, purgeAt: nil, meta: ItemMeta(name: name, mime: "image/jpeg", size: size, lastModified: 0, capture_ts: 0),
         itemKey: nil, broken: false)
  }

  @Test func newestUploadOfTheWatchedFolders() {
    let items = [item("1", name: "a.jpg", size: 10, at: 100), item("2", name: "b.jpg", size: 20, at: 300), item("3", name: "c.jpg", size: 30, at: 200)]
    let done: Set<String> = [Crypto.fingerprint(name: "a.jpg", size: 10), Crypto.fingerprint(name: "c.jpg", size: 30)]
    #expect(LastUpload.newest(items: items, done: done) == 200)
    #expect(LastUpload.newest(items: items, done: []) == 0)
    #expect(LastUpload.newest(items: [], done: done) == 0)
    // never after the watcher last wrote its state
    #expect(LastUpload.newest(items: items, done: done, notAfter: Date(timeIntervalSince1970: 150)) == 150)
    // same name, other size: not this Mac's
    #expect(LastUpload.newest(items: [item("4", name: "a.jpg", size: 11, at: 900)], done: done) == 0)
  }

  private func me(session: String?, demo: Bool = false) throws -> Me {
    var j: [String: Any] = ["user": ["id": "0123456789abcdef0123456789abcdef", "email": "a@x.org", "role": "user"], "csrf": "c",
                            "kdf": ["alg": "argon2id13", "v": 1, "ops": 3, "mem": 67108864, "salt": "AAAAAAAAAAAAAAAAAAAAAA"],
                            "wrapped_master_pw": "x", "wrapped_privkey": "x", "pubkey": "x", "demo": demo]
    if let session { j["session_id"] = session }
    return try JSONDecoder().decode(Me.self, from: JSONSerialization.data(withJSONObject: j))
  }

  @Test func sentOncePerSession() throws {
    #expect(LastUpload.due(me: try me(session: "s1"), sentFor: nil, at: 100))
    #expect(LastUpload.due(me: try me(session: "s1"), sentFor: "s0", at: 100))
    #expect(!LastUpload.due(me: try me(session: "s1"), sentFor: "s1", at: 100))
    #expect(!LastUpload.due(me: try me(session: "s1"), sentFor: nil, at: 0))
    #expect(!LastUpload.due(me: try me(session: nil), sentFor: nil, at: 100))
    #expect(!LastUpload.due(me: try me(session: "s1", demo: true), sentFor: nil, at: 100))
  }
}
