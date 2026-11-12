// Two-step sign-in, devices and notices: the answers of server/twofactor.go and server/notices.go as the app reads them.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct TwoFactorTests {
  @Test func onlyAnOtpauthTotpAddressIsOpened() throws {
    func setup(_ uri: String) throws -> TwoFactor.Setup {
      try JSONDecoder().decode(TwoFactor.Setup.self, from: JSONSerialization.data(withJSONObject: ["secret": "ABC", "uri": uri]))
    }
    #expect(try setup("otpauth://totp/Cipherfilm:me%40x.org?secret=ABC&issuer=Cipherfilm").totpURL != nil)
    for u in ["https://evil.example/", "otpauth://hotp/x", "file:///Applications/Calculator.app", "x-apple.systempreferences:", "smb://host/share", ""] {
      #expect(try setup(u).totpURL == nil)
    }
  }

  @Test func passwordAnswerBecomesACodeStep() {
    let kek = Data(repeating: 7, count: 32)
    let e = APIError(status: 401, message: "x", code: "two_factor_required", pending: "tok")
    let step = CodeStep(e, email: "a@x.org", kek: kek, now: Date(timeIntervalSince1970: 1000))
    #expect(step != nil)
    #expect(step?.pending == "tok")
    #expect(step?.email == "a@x.org")
    #expect(step?.expires == Date(timeIntervalSince1970: 1300))
    #expect(step?.key == kek)
    // the key is forgotten once the step ends
    step?.abandon()
    #expect(step?.abandoned == true)
    #expect(step?.key == nil)
    // anything else is no code step: a wrong password stays an error
    #expect(CodeStep(APIError(status: 401, message: "wrong e-mail or password"), email: "a@x.org", kek: kek) == nil)
    #expect(CodeStep(APIError(status: 401, message: "x", code: "two_factor_required"), email: "a@x.org", kek: kek) == nil)
  }

  @Test func meReadsTwoFactor() throws {
    let json = """
    {"user":{"id":"0123456789abcdef0123456789abcdef","email":"a@x.org","role":"user"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},
     "wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x","two_factor":true}
    """
    #expect(try JSONDecoder().decode(Me.self, from: Data(json.utf8)).two_factor == true)
    let old = json.replacingOccurrences(of: ",\"two_factor\":true", with: "")
    #expect(try JSONDecoder().decode(Me.self, from: Data(old.utf8)).two_factor == nil)
  }

  @Test func codesAsTyped() {
    #expect(TwoFactor.ready("123456", recovery: false))
    #expect(TwoFactor.ready(" 123 456 ", recovery: false))
    #expect(!TwoFactor.ready("12345", recovery: false))
    #expect(!TwoFactor.ready("12345a", recovery: false))
    #expect(TwoFactor.ready("abcd-efgh-jkmn-pq12", recovery: true))
    #expect(TwoFactor.ready("ABCD EFGH JKMN PQ12", recovery: true))
    #expect(!TwoFactor.ready("abcd-efgh-jkmn-pq1", recovery: true))
    #expect(!TwoFactor.ready("abcd-efgh-jkmn-pq1!", recovery: true))
    #expect(TwoFactor.clean("ab cd-ef") == "abcdef")
    #expect(TwoFactor.grouped("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") == "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")
    #expect(TwoFactor.grouped("ABCDEF") == "ABCD EF")
  }

  @Test func statusAndSetupDecode() throws {
    let s = try JSONDecoder().decode(TwoFactor.Status.self, from: Data(#"{"enabled":true,"recovery_codes_left":9,"available":true}"#.utf8))
    #expect(s == TwoFactor.Status(enabled: true, recovery_codes_left: 9, available: true, totp: nil, passkeys: nil))
    #expect(s.hasApp) // an older server: on means the app
    let p = try JSONDecoder().decode(TwoFactor.Status.self, from: Data(#"{"enabled":true,"recovery_codes_left":9,"available":true,"totp":false,"passkeys":2}"#.utf8))
    #expect(!p.hasApp && p.passkeys == 2)
    let u = try JSONDecoder().decode(TwoFactor.Setup.self, from: Data(#"{"secret":"ABC","uri":"otpauth://totp/x","algorithm":"SHA1","digits":6,"period":30}"#.utf8))
    #expect(u.uri == "otpauth://totp/x")
  }

  @Test func devicesDecode() throws {
    let d = try JSONDecoder().decode(Device.self, from: Data(#"{"id":"0123456789abcdef01234567","device":"","created_at":1,"last_seen":2,"current":true,"indexer":false}"#.utf8))
    #expect(d.name == "Unknown device")
    #expect(d.current)
  }

  @Test func noticesShownAndWorded() {
    let list = [
      Notice(id: 1, kind: "sign_in", device: "Pixel 8 (Android app)", at: 100),
      Notice(id: 3, kind: "something_new", device: "", at: 300),
      Notice(id: 2, kind: "2fa_reset", device: "", at: 200),
    ]
    let shown = Notice.shown(list)
    #expect(shown.map(\.id) == [2, 1]) // unknown kinds left out, newest first
    #expect(shown[1].text(time: "Nov 11, 10:00") == "New sign-in: Pixel 8 (Android app), Nov 11, 10:00. Not you? Review devices.")
    #expect(shown[1].reviewDevices)
    #expect(shown[0].text(time: "Nov 11") == "An administrator turned off two-step sign-in for your account (Nov 11). Turn it on again in Settings.")
    #expect(!shown[0].reviewDevices)
    #expect(Notice(id: 4, kind: "sign_in", device: "", at: 0).text(time: "t").contains("an unknown device"))
    #expect(shown[0].opensSettings && shown[1].opensSettings)
    let used = Notice.shown([Notice(id: 5, kind: "password_used", device: "", at: 50)])
    #expect(used.map(\.id) == [5])
    #expect(used[0].text(time: "Nov 11") == "Your password was used to start a sign-in that wasn't finished (Nov 11). Not you? Change your password in Cipherfilm in the browser.")
    #expect(!used[0].reviewDevices && !used[0].opensSettings)
  }

  @Test func changesToTwoStepSignInWorded() {
    let kinds = ["totp_added", "totp_removed", "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"]
    let list = kinds.enumerated().map { Notice(id: Int64($0.offset + 1), kind: $0.element, device: "Pixel 8 (Android app)", at: 100) }
    #expect(Notice.shown(list).count == kinds.count)
    let t = Dictionary(uniqueKeysWithValues: list.map { ($0.kind, $0.text(time: "Nov 11, 10:00")) })
    #expect(t["totp_added"] == "An authenticator app was added to two-step sign-in on Pixel 8 (Android app), Nov 11, 10:00. Not you?")
    #expect(t["totp_removed"] == "The authenticator app was removed from two-step sign-in on Pixel 8 (Android app), Nov 11, 10:00. Not you?")
    #expect(t["passkey_added"] == "A passkey was added to two-step sign-in on Pixel 8 (Android app), Nov 11, 10:00. Not you?")
    #expect(t["passkey_removed"] == "A passkey was removed from two-step sign-in on Pixel 8 (Android app), Nov 11, 10:00. Not you?")
    #expect(t["recovery_codes"] == "New recovery codes were made on Pixel 8 (Android app), Nov 11, 10:00; the old ones no longer work. Not you?")
    #expect(t["2fa_off"] == "Two-step sign-in was turned off on Pixel 8 (Android app), Nov 11, 10:00. Not you?")
    // they open two-step sign-in in Settings, not the device list
    #expect(list.allSatisfy { $0.opensSettings && !$0.reviewDevices })
    #expect(Notice(id: 9, kind: "2fa_off", device: "", at: 0).text(time: "t") == "Two-step sign-in was turned off on an unknown device, t. Not you?")
  }

  @Test func secondStepBodies() throws {
    #expect(try TwoFactor.Second.none.body("p") as NSDictionary == ["current_auth": "p"] as NSDictionary)
    #expect(try TwoFactor.Second.code(" 123 456 ").body("p") as NSDictionary == ["current_auth": "p", "code": "123456"] as NSDictionary)
    #expect(try TwoFactor.Second.code("abcd-efgh-jkmn-pq12").body("p") as NSDictionary == ["current_auth": "p", "code": "abcdefghjkmnpq12"] as NSDictionary)
    let pk = try TwoFactor.Second.passkey(Data(#"{"id":"k","type":"public-key"}"#.utf8)).body("p")
    #expect(pk["current_auth"] as? String == "p" && pk["code"] == nil)
    #expect(pk["passkey"] as? NSDictionary == ["id": "k", "type": "public-key"] as NSDictionary)
    #expect(throws: (any Error).self) { try TwoFactor.Second.passkey(Data("no".utf8)).body("p") }
  }

  @Test func secondStepAnswersWorded() async {
    for (code, says) in [("second_step_required", TwoFactor.secondStepNeeded), ("wrong_code", TwoFactor.wrongCode), ("wrong_passkey", Passkeys.wrongPasskey)] {
      do {
        _ = try await TwoFactor.friendly { throw APIError(status: 403, message: "x", code: code) }
        Issue.record("no error")
      } catch let e as APIError {
        #expect(e.code == code && e.status == 403 && e.errorDescription == says)
        #expect(TwoFactor.needsSecondStep(e) == (code == "second_step_required"))
      } catch { Issue.record("\(error)") }
    }
    // a wrong password (no code) and the only administrator stay as the server says them
    do { _ = try await TwoFactor.friendly { throw APIError(status: 409, message: "only admin") } } catch let e as APIError {
      #expect(e.errorDescription == "only admin" && !TwoFactor.needsSecondStep(e))
    } catch { Issue.record("\(error)") }
  }

  @Test func liveKnowsNotices() {
    #expect(LiveSignal(SSEvent(event: "changed", data: #"{"v":5,"what":["notices"]}"#)) == .changed(v: 5, what: [.notices]))
  }

  @Test func passwordAnswerSaysWhichSecondSteps() {
    let kek = Data(repeating: 7, count: 32)
    let pk = CodeStep(APIError(status: 401, message: "x", code: "two_factor_required", pending: "tok", totp: false, passkey: true), email: "a@x.org", kek: kek)
    #expect(pk?.passkey == true && pk?.totp == false)
    // an older server names none: the app's code, as before
    let old = CodeStep(APIError(status: 401, message: "x", code: "two_factor_required", pending: "tok"), email: "a@x.org", kek: kek)
    #expect(old?.passkey == false && old?.totp == true)
  }

  @Test func passkeyHandoffToTheBrowserAndBack() throws {
    let options = Data(#"{"challenge":"AQID","rpId":"photos.example"}"#.utf8)
    let u = try Passkeys.handoffURL(server: URL(string: "https://photos.example/")!, op: "get", options: options)
    #expect(u.absoluteString.hasPrefix("https://photos.example/passkey#"))
    // the fragment holds what the page reads: the step and the options, base64url JSON (never sent to the server)
    let frag = try #require(u.fragment)
    #expect(!frag.contains("=") && !frag.contains("+") && !frag.contains("/"))
    let raw = try #require(Passkeys.unb64url(frag))
    let h = try #require(JSONSerialization.jsonObject(with: raw) as? [String: Any])
    #expect(h["op"] as? String == "get")
    #expect((h["options"] as? [String: Any])?["rpId"] as? String == "photos.example")
    #expect(throws: (any Error).self) { try Passkeys.handoffURL(server: URL(string: "http://photos.example")!, op: "get", options: options) }
    #expect(throws: (any Error).self) { try Passkeys.handoffURL(server: URL(string: "https://photos.example")!, op: "steal", options: options) }

    let answer = Data(#"{"id":"k","type":"public-key"}"#.utf8)
    let back = URL(string: "cipherfilm-mac://passkey#" + Passkeys.b64url(answer))!
    #expect(try JSONSerialization.jsonObject(with: Passkeys.answer(from: back)) as? [String: String] == ["id": "k", "type": "public-key"])
    #expect(throws: (any Error).self) { try Passkeys.answer(from: URL(string: "cipherfilm-mac://passkey#error=cancelled")!) }
    #expect(throws: (any Error).self) { try Passkeys.answer(from: URL(string: "cipherfilm://passkey#" + Passkeys.b64url(answer))!) }
    #expect(throws: (any Error).self) { try Passkeys.answer(from: URL(string: "cipherfilm-mac://other#" + Passkeys.b64url(answer))!) }
  }

  @Test func passkeysDecode() throws {
    struct L: Decodable { let passkeys: [Passkeys.Item] }
    let l = try JSONDecoder().decode(L.self, from: Data(#"{"passkeys":[{"id":"0123456789abcdef0123456789abcdef","name":"Key","rp_id":"photos.example","here":true,"created_at":1,"last_used_at":0}],"available":true,"max":20}"#.utf8))
    #expect(l.passkeys.first?.name == "Key" && l.passkeys.first?.here == true)
  }
}

// Notices as macOS notifications (NoticeAlerts): each at most once, none while the banner shows them.
@Suite struct NoticeAlertsTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func n(_ id: Int64, ago: TimeInterval = 60, kind: String = "sign_in") -> Notice {
    Notice(id: id, kind: kind, device: "Pixel 8 (Android app)", at: Int64(now.timeIntervalSince1970 - ago))
  }

  @Test func eachOnceOldestFirst() {
    var a = NoticeAlerts()
    #expect(a.take([n(3, ago: 10), n(2, ago: 100)], server: "s", now: now, visible: false).map(\.id) == [2, 3])
    #expect(a.take([n(3), n(2)], server: "s", now: now, visible: false).isEmpty)
    #expect(a.take([n(4), n(3), n(2)], server: "s", now: now, visible: false).map(\.id) == [4])
  }

  @Test func noneWhileTheBannerShowsThem() {
    var a = NoticeAlerts()
    #expect(a.take([n(5)], server: "s", now: now, visible: true).isEmpty)
    // and not later either, once the window is gone
    #expect(a.take([n(5)], server: "s", now: now, visible: false).isEmpty)
  }

  @Test func oldOnesOnlyRemembered() {
    var a = NoticeAlerts()
    #expect(a.take([n(9), n(8, ago: NoticeAlerts.recent + 1)], server: "s", now: now, visible: false).map(\.id) == [9])
    #expect(a.ids == [9, 8])
  }

  @Test func perServerAndBounded() throws {
    var a = NoticeAlerts()
    _ = a.take([n(7)], server: "s", now: now, visible: false)
    #expect(a.take([n(7)], server: "other", now: now, visible: false).map(\.id) == [7])
    _ = a.take((1...Int64(NoticeAlerts.keep + 30)).map { n($0) }, server: "other", now: now, visible: true)
    #expect(a.ids.count == NoticeAlerts.keep)
    #expect(a.ids.first == Int64(NoticeAlerts.keep + 30))
    // kept in UserDefaults as JSON
    let back = try JSONDecoder().decode(NoticeAlerts.self, from: JSONEncoder().encode(a))
    #expect(back == a)
  }

  @Test func titleSaysNothingAboutTheDevice() {
    #expect(NoticeAlerts.title(n(1)) == "New sign-in to Cipherfilm")
    #expect(!NoticeAlerts.title(n(1)).contains("Pixel"))
    #expect(NoticeAlerts.title(n(2, kind: "2fa_reset")) == "Two-step sign-in turned off")
    #expect(NoticeAlerts.title(n(3, kind: "password_used")) == "Unfinished sign-in to Cipherfilm")
    #expect(NoticeAlerts.title(n(4, kind: "totp_added")) == "Two-step sign-in changed")
    #expect(NoticeAlerts.title(n(5, kind: "passkey_removed")) == "Two-step sign-in changed")
    #expect(NoticeAlerts.title(n(6, kind: "recovery_codes")) == "New recovery codes made")
    #expect(NoticeAlerts.title(n(7, kind: "2fa_off")) == "Two-step sign-in turned off")
    for k in Notice.kinds { #expect(!NoticeAlerts.title(n(8, kind: k)).contains("Pixel")) }
  }
}
