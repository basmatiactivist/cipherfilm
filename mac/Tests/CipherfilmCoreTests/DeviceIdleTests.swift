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

  @Test func oddLastSeenTimesDontTrap() throws {
    let d: [String: Any] = ["id": "x", "device": "", "created_at": 0, "last_seen": Int64.min, "current": false, "indexer": false]
    let dev = try JSONDecoder().decode(Device.self, from: JSONSerialization.data(withJSONObject: d))
    #expect(DeviceIdle.unused([dev], days: 30, now: now).map(\.id) == ["x"])
  }

  /** The time sent is this Mac's own note of its last upload: nothing the server lists can change it. */
  @Test func lastUploadIsThisMacsOwnNote() {
    #expect(LastUpload.time(Date(timeIntervalSince1970: 1_799_000_000), now: now) == 1_799_000_000)
    #expect(LastUpload.time(nil, now: now) == 0)
    #expect(LastUpload.time(Date(timeIntervalSince1970: 1_900_000_000), now: now) == 1_800_000_000) // never in the future
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
