// Administration: the requests (exactly the web's, server/handlers_admin.go), the checks and the wording.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct AdminTests {
  let id = "0123456789abcdef0123456789abcdef"

  func me(role: String, demo: Bool = false) throws -> Me {
    let json = """
    {"user":{"id":"\(id)","email":"a@x.org","role":"\(role)"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},
     "wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x"\(demo ? ",\"demo\":true" : "")}
    """
    return try JSONDecoder().decode(Me.self, from: Data(json.utf8))
  }

  func user(_ quota: Int64 = 10_000_000_000, items: Int = 3, role: String = "user", status: String = "active", nsfw: Bool = false, twoFactor: Bool? = nil) throws -> Admin.User {
    let tf = twoFactor.map { ",\"two_factor\":\($0)" } ?? ""
    let json = """
    {"id":"\(id)","email":"b@x.org","role":"\(role)","status":"\(status)","created_at":1,"last_login_at":0,"quota_bytes":\(quota),"used_bytes":2500000000,"item_count":\(items),"nsfw":\(nsfw)\(tf)}
    """
    return try JSONDecoder().decode(Admin.User.self, from: Data(json.utf8))
  }

  @Test func offeredToAdminsOnlyNeverTheDemo() throws {
    #expect(Admin.offered(try me(role: "admin")))
    #expect(!Admin.offered(try me(role: "user")))
    #expect(!Admin.offered(try me(role: "admin", demo: true)))
    #expect(!Admin.offered(nil))
  }

  @Test func refusedMeansNoAccess() {
    #expect(Admin.noAccess(APIError(status: 404, message: "Not found.")))
    #expect(Admin.noAccess(APIError(status: 403, message: "x")))
    #expect(!Admin.noAccess(APIError(status: 409, message: "x")))
    #expect(!Admin.noAccess(URLError(.notConnectedToInternet)))
  }

  @Test func requestsAreTheWebs() throws {
    func r(_ a: Admin.Action) throws -> String {
      let x = try Admin.request(a)
      let body = x.body.map { String(data: try! JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), encoding: .utf8)! } ?? "-"
      return "\(x.method) \(x.path) \(body)"
    }
    #expect(try r(.change(id, .enabled(false))) == "PATCH /api/admin/users/\(id) {\"status\":\"disabled\"}")
    #expect(try r(.change(id, .enabled(true))) == "PATCH /api/admin/users/\(id) {\"status\":\"active\"}")
    #expect(try r(.change(id, .admin(true))) == "PATCH /api/admin/users/\(id) {\"role\":\"admin\"}")
    #expect(try r(.change(id, .admin(false))) == "PATCH /api/admin/users/\(id) {\"role\":\"user\"}")
    #expect(try r(.change(id, .explicit(true))) == "PATCH /api/admin/users/\(id) {\"nsfw\":true}")
    #expect(try r(.change(id, .limit(5_000_000_000))) == "PATCH /api/admin/users/\(id) {\"quota_bytes\":5000000000}")
    #expect(try r(.delete(id)) == "DELETE /api/admin/users/\(id) -")
    #expect(try r(.resetTwoStep(id)) == "DELETE /api/admin/users/\(id)/2fa -")
    #expect(try r(.revokeInvite(id)) == "DELETE /api/admin/invites/\(id) -")
    #expect(try r(.defaultLimit(0)) == "PATCH /api/admin/settings {\"default_quota_bytes\":0}")
    #expect(try r(.invite(email: " c@x.org ", limit: nil)) == "POST /api/admin/invites {\"email\":\"c@x.org\"}")
    #expect(try r(.invite(email: "c@x.org", limit: 0)) == "POST /api/admin/invites {\"email\":\"c@x.org\",\"quota_bytes\":0}")
  }

  @Test func onlyServerIdsGoIntoPaths() {
    for bad in ["../me", "x", id.uppercased(), id + "/2fa", ""] {
      #expect(throws: APIError.self) { try Admin.request(.delete(bad)) }
      #expect(throws: APIError.self) { try Admin.request(.change(bad, .enabled(false))) }
      #expect(throws: APIError.self) { try Admin.request(.revokeInvite(bad)) }
    }
  }

  @Test func inviteLinkUsesTheServersAddress() {
    #expect(Admin.link(origin: URL(string: "https://photos.example.test/")!, token: "tok_en-1") == "https://photos.example.test/invite/tok_en-1")
    #expect(Admin.link(origin: URL(string: "https://h.test:8443")!, token: "a/b") == "https://h.test:8443/invite/a%2Fb")
  }

  @Test func limitsAsTyped() throws {
    #expect(try Admin.parseGB("5") == 5_000_000_000)
    #expect(try Admin.parseGB(" 1,5 ") == 1_500_000_000)
    #expect(try Admin.parseGB("0") == 0)
    #expect(try Admin.parseGB("", optional: true) == nil)
    for bad in ["", "-1", "abc", "inf", "nan"] { #expect(throws: APIError.self) { try Admin.parseGB(bad) } }
  }

  @Test func wordingAsOnTheWeb() throws {
    #expect(Admin.size(2_500_000_000) == "2.5 GB")
    #expect(Admin.size(12_000_000) == "12 MB")
    #expect(Admin.size(10) == "less than 1 MB")
    #expect(Admin.limit(0) == "no limit")
    #expect(Admin.usage(try user()) == "2.5 GB of 10.0 GB · 3 items")
    #expect(Admin.usage(try user(0, items: 1)) == "2.5 GB used, no limit · 1 item")
    #expect(Admin.summary([try user(), try user()]) == "2 people · 5.0 GB stored · 6 items")
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    #expect(Admin.lastSeen(0, now: now) == "never signed in")
    #expect(Admin.lastSeen(1_700_000_000 - 60, now: now) == "active today")
    #expect(Admin.lastSeen(1_700_000_000 - 86400, now: now) == "active yesterday")
    #expect(Admin.lastSeen(1_700_000_000 - 5 * 86400, now: now) == "active 5 days ago")
    #expect(Admin.badges(try user(role: "admin", status: "disabled", nsfw: true, twoFactor: true)) == ["admin", "disabled", "explicit search", "two-step sign-in"])
    #expect(Admin.badges(try user()) == ["user"])
    #expect(Admin.uptime(7200) == "2 hours")
    #expect(Admin.uptime(3600) == "1 hour")
    #expect(Admin.uptime(86400) == "1 day")
    #expect(Admin.uptime(3 * 86400) == "3 days")
    #expect(Admin.uptime(60) == "1 minute")
    #expect(Admin.uptime(30) == "0 minutes")
    #expect(Admin.gbText(21_500_000_000) == "21.5")
    #expect(Admin.gbText(5_000_000_000) == "5")
    #expect(Admin.gbText(0) == "0")
    #expect(Admin.gbText(1_250_000_000) == "1.25")
    #expect(try Admin.parseGB(Admin.gbText(21_500_000_000)) == 21_500_000_000)
  }

  @Test func backupState() throws {
    func s(ok: Int64? = nil, failed: Int64? = nil, step: String? = nil) throws -> Admin.Status {
      var o: [String: Any] = ["disk_free_bytes": 1, "disk_total_bytes": 2, "data_bytes": 1, "active_sessions": 1, "last_backup_at": 0, "uptime_seconds": 1]
      if let ok { o["backup_ok_at"] = ok }
      if let failed { o["backup_failed_at"] = failed }
      if let step { o["backup_failed_in"] = step }
      return try JSONDecoder().decode(Admin.Status.self, from: JSONSerialization.data(withJSONObject: o))
    }
    let now = Date(timeIntervalSince1970: 1_700_000_000), t: Int64 = 1_700_000_000
    #expect(Admin.backup(try s(), now: now).problem == nil)
    #expect(Admin.backup(try s(ok: t - 3600), now: now).problem == nil)
    #expect(Admin.backup(try s(ok: t - 40 * 3600), now: now).problem?.hasPrefix("No off-site backup since") == true)
    #expect(Admin.backup(try s(ok: t - 7200, failed: t - 60, step: "snapshot"), now: now).problem?.contains("database snapshot couldn't be written") == true)
    #expect(Admin.backup(try s(failed: t - 60, step: "upload"), now: now).problem?.hasSuffix("None has succeeded yet.") == true)
  }

  @Test func activityAsSentences() {
    func e(_ action: String, actor: String = "me@x.org", target: String = "b@x.org", detail: String = "", at: Int64 = 0) -> Admin.Entry {
      Admin.Entry(at: at, actor: actor, action: action, target: target, detail: detail)
    }
    #expect(Admin.describe(e("invited"), me: "me@x.org").text == "You invited b@x.org")
    #expect(Admin.describe(e("role changed", actor: "c@x.org", target: "me@x.org", detail: "admin"), me: "me@x.org").text == "c@x.org made you an administrator")
    let d = Admin.describe(e("deleted"), me: "me@x.org")
    #expect(d.text == "You deleted b@x.org and everything they stored" && d.warn)
    #expect(Admin.describe(e("storage limit changed", detail: "0"), me: "me@x.org").text == "You set the storage limit of b@x.org to no limit")
    #expect(Admin.describe(e("joined", actor: "b@x.org"), me: "me@x.org").text == "b@x.org joined")
    #expect(Admin.describe(e("signed out every device", actor: "server console", detail: "wipe"), me: "me@x.org").text == "The server console signed out every device of b@x.org, and they delete what they keep")
    #expect(Admin.describe(e("something new", detail: "d"), me: "me@x.org").text == "You something new · b@x.org (d)")
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let noonSec: Int64 = 1_700_000_000 - 1_700_000_000 % 86400 + 43200
    let noon = Date(timeIntervalSince1970: TimeInterval(noonSec))
    let n = Int64(noon.timeIntervalSince1970)
    let groups = Admin.byDay([e("invited", at: n), e("enabled", at: n - 3600), e("disabled", at: n - 86400)], now: noon, calendar: cal)
    #expect(groups.map(\.day) == ["Today", "Yesterday"])
    #expect(groups.map(\.entries.count) == [2, 1])
  }
}
