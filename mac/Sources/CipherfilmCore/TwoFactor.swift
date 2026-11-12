// Two-step sign-in (server/twofactor.go), the account's signed-in devices and the notices the server keeps for them
// (server/notices.go). Unlocking a Mac that is already signed in never asks for a code: it never asks the server.
import Foundation

/** How a sign-in went: done, or the password was right and the account wants a code first. */
public enum SignIn: Sendable {
  case done(Me, Data)
  case code(CodeStep)
}

/** A sign-in waiting for its code. It holds the key the password made (to open the account's master key once the
 *  server answers with it) in memory only, until the code step finishes or is abandoned; then it is zeroed. */
public final class CodeStep: @unchecked Sendable {
  public let email: String
  let pending: String
  public let expires: Date
  /** what the account has: an authenticator app (also when an older server doesn't say), a passkey for this server */
  public let totp: Bool
  public let passkey: Bool
  private let lock = NSLock()
  private var kek: Data?

  static let expiredError = APIError(status: 401, message: "This sign-in expired. Sign in again with your password.", code: "two_factor_expired")

  /** A step from the password answer, or nil when the answer is anything but "two_factor_required". */
  init?(_ e: APIError, email: String, kek: Data, now: Date = Date()) {
    guard e.code == "two_factor_required", let p = e.pending, !p.isEmpty else { return nil }
    self.email = email
    self.pending = p
    self.kek = Data(kek) // a copy: the caller zeroes its own
    self.expires = now.addingTimeInterval(300)
    self.totp = e.totp ?? (e.passkey == nil)
    self.passkey = e.passkey ?? false
  }

  var key: Data? { lock.withLock { kek } }
  public var abandoned: Bool { key == nil }

  /** Forgets the key (start over, expired, or the sign-in finished). */
  public func abandon() {
    lock.withLock {
      // in place: a `var k = kek` copy would make memzero zero a fresh copy and leave the key's own bytes as they were
      if kek != nil { Sodium.memzero(&kek!) }
      kek = nil
    }
  }

  deinit { abandon() }
}

public enum TwoFactor {
  static let wrongCode = "That code isn't right. Check the time on your phone, or use a recovery code."

  /** A code as typed: spaces and dashes out. Recovery codes keep their letters (the server reads them in any case). */
  public static func clean(_ code: String) -> String {
    code.filter { !$0.isWhitespace && $0 != "-" }
  }

  /** Whether what was typed has the shape of a code: six digits, or (recovery) sixteen letters and digits. */
  public static func ready(_ code: String, recovery: Bool) -> Bool {
    let c = clean(code)
    if recovery { return c.count == 16 && c.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } }
    return c.count == 6 && c.allSatisfy { $0.isASCII && $0.isNumber }
  }

  /** The secret in groups of four, for typing into an authenticator by hand. */
  public static func grouped(_ secret: String) -> String {
    stride(from: 0, to: secret.count, by: 4).map { i in
      let a = secret.index(secret.startIndex, offsetBy: i)
      return String(secret[a..<secret.index(a, offsetBy: min(4, secret.count - i))])
    }.joined(separator: " ")
  }

  public struct Status: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public let recovery_codes_left: Int
    /** false for the public demo login */
    public let available: Bool
    /** what the account has (an older server leaves them out: then "enabled" means the app) */
    public let totp: Bool?
    public let passkeys: Int?
    public var hasApp: Bool { totp ?? enabled }
  }

  public struct Setup: Decodable, Sendable, Equatable {
    public let secret: String
    /** otpauth://totp/…: what the QR code holds */
    public let uri: String
    /** The address to open in an authenticator app: only an otpauth://totp/ one (a server that isn't honest could send
     *  any other scheme or a web page, which NSWorkspace would open with the app registered for it). */
    public var totpURL: URL? {
      guard uri.prefix(15).lowercased() == "otpauth://totp/", let u = URL(string: uri), u.scheme?.lowercased() == "otpauth" else { return nil }
      return u
    }
  }

  struct Codes: Decodable { let recovery_codes: [String]? }

  /** The second step a change needs while two-step sign-in is on: a code (app or recovery), or a passkey's answer. */
  public enum Second: Sendable {
    case none
    case code(String)
    case passkey(Data)

    func body(_ proof: String) throws -> [String: Any] {
      switch self {
      case .none: return ["current_auth": proof]
      case .code(let c): return ["current_auth": proof, "code": TwoFactor.clean(c)]
      case .passkey(let d):
        guard let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { throw Passkeys.noAnswer }
        return ["current_auth": proof, "passkey": obj]
      }
    }
  }

  public static func status(api: API) async throws -> Status { try await api.get(Status.self, "/api/me/2fa") }

  /** A new secret to show (not on until a code from it is confirmed). While a passkey has two-step sign-in on, adding
   *  the app needs a second step too. */
  public static func setup(api: API, me: Me, password: String, second: Second = .none) async throws -> Setup {
    let proof = try Account.proof(me: me, password: password)
    return try JSONDecoder().decode(Setup.self, from: try await friendly { try await api.json("POST", "/api/me/2fa/setup", body: try second.body(proof)) })
  }

  /** Turns the app on with a code from the new secret; returns the ten recovery codes, shown only now, or nil when a
   *  passkey had two-step sign-in on already (the codes stay as they were). */
  public static func enable(api: API, code: String) async throws -> [String]? {
    try JSONDecoder().decode(Codes.self, from: try await friendly { try await api.json("POST", "/api/me/2fa/enable", body: ["code": clean(code)]) }).recovery_codes
  }

  public static func disable(api: API, me: Me, password: String, second: Second) async throws {
    let proof = try Account.proof(me: me, password: password)
    _ = try await friendly { try await api.json("POST", "/api/me/2fa/disable", body: try second.body(proof)) }
  }

  /** Removes the authenticator app; the passkeys stay. */
  public static func removeApp(api: API, me: Me, password: String, second: Second) async throws {
    let proof = try Account.proof(me: me, password: password)
    _ = try await friendly { try await api.json("POST", "/api/me/2fa/totp/remove", body: try second.body(proof)) }
  }

  /** New recovery codes; the old ones stop working. */
  public static func newCodes(api: API, me: Me, password: String, second: Second) async throws -> [String] {
    let proof = try Account.proof(me: me, password: password)
    return try JSONDecoder().decode(Codes.self, from: try await friendly { try await api.json("POST", "/api/me/2fa/recovery-codes", body: try second.body(proof)) }).recovery_codes ?? []
  }

  static let secondStepNeeded = "Two-step sign-in is on for your account: this also needs a code from your authenticator app, a recovery code or a passkey."

  /** The server asked for a second step this change was sent without (two-step sign-in was turned on elsewhere). */
  public static func needsSecondStep(_ e: Error) -> Bool { (e as? APIError)?.code == "second_step_required" }

  static func friendly(_ f: () async throws -> Data) async throws -> Data {
    do { return try await f() } catch let e as APIError where e.code == "second_step_required" {
      throw APIError(status: e.status, message: secondStepNeeded, code: e.code)
    } catch let e as APIError where e.code == "wrong_code" {
      throw APIError(status: e.status, message: wrongCode, code: e.code)
    } catch let e as APIError where e.code == "wrong_passkey" {
      throw APIError(status: e.status, message: Passkeys.wrongPasskey, code: e.code)
    }
  }
}

/** Passkeys as the second step (server/passkeys.go). A Mac app can use passkeys only of the web names it was built for
 *  (Associated Domains, fixed when Apple signs the app), which can't list every self-hosted server; so the app hands
 *  the ceremony to the browser: it opens the server's own /passkey page in a sign-in window (ASWebAuthenticationSession)
 *  with the options in the address's fragment, the browser asks for the passkey on the server's real address, and the
 *  page hands the answer back to cipherfilm-mac://, which only that waiting window receives. */
public enum Passkeys {
  public static let scheme = "cipherfilm-mac"
  static let wrongPasskey = "That passkey wasn't accepted. Try again, or use a code."
  static let noAnswer = APIError(status: -1, message: "No passkey was used. Try again, or use a code instead.")

  public struct Item: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let rp_id: String
    public let here: Bool
    public let created_at: Int64
    public let last_used_at: Int64
  }

  public static func list(api: API) async throws -> [Item] {
    struct L: Decodable { let passkeys: [Item] }
    return try await api.get(L.self, "/api/me/passkeys").passkeys
  }

  /** The "options" of a challenge answer, as JSON. */
  static func options(_ answer: Data) throws -> Data {
    guard let obj = try? JSONSerialization.jsonObject(with: answer) as? [String: Any], let o = obj["options"] as? [String: Any] else {
      throw APIError(status: -1, message: "The server sent no passkey challenge.")
    }
    return try JSONSerialization.data(withJSONObject: o)
  }

  /** The signed-in session's own challenge, for a change that needs a second step. */
  public static func proofChallenge(api: API) async throws -> Data {
    try options(try await api.json("POST", "/api/me/2fa/passkey", body: [String: Any]()))
  }

  /** Starts adding a passkey (checks the password and, while two-step sign-in is on, the second step): the options. */
  public static func beginAdd(api: API, me: Me, password: String, second: TwoFactor.Second) async throws -> Data {
    let proof = try Account.proof(me: me, password: password)
    return try options(try await TwoFactor.friendly { try await api.json("POST", "/api/me/passkeys/register/begin", body: try second.body(proof)) })
  }

  /** Stores the new passkey; returns the recovery codes when it is the account's first second step. */
  public static func finishAdd(api: API, name: String, credential: Data) async throws -> [String]? {
    guard let obj = try? JSONSerialization.jsonObject(with: credential) as? [String: Any] else { throw noAnswer }
    return try JSONDecoder().decode(TwoFactor.Codes.self, from: try await api.json("POST", "/api/me/passkeys/register/finish", body: ["name": name, "credential": obj])).recovery_codes
  }

  public static func remove(api: API, me: Me, password: String, second: TwoFactor.Second, id: String) async throws {
    guard ServerId.valid(id) else { throw APIError(status: -1, message: "That passkey can't be removed from here.") }
    let proof = try Account.proof(me: me, password: password)
    _ = try await TwoFactor.friendly { try await api.json("DELETE", "/api/me/passkeys/\(id)", body: try second.body(proof)) }
  }

  /** The address of the server's /passkey page with what to do ("get" or "create") and the options in the fragment,
   *  which the browser never sends to the server. */
  public static func handoffURL(server: URL, op: String, options: Data) throws -> URL {
    guard op == "get" || op == "create", let o = try? JSONSerialization.jsonObject(with: options) else { throw noAnswer }
    let frag = b64url(try JSONSerialization.data(withJSONObject: ["op": op, "options": o]))
    guard var c = URLComponents(url: server, resolvingAgainstBaseURL: false), c.scheme == "https" else {
      throw APIError(status: -1, message: "Passkeys need the server's https address.")
    }
    c.path = "/passkey"; c.query = nil; c.fragment = nil
    guard let u = c.url, let out = URL(string: u.absoluteString + "#" + frag) else { throw noAnswer }
    return out
  }

  /** The passkey's answer (JSON) from the page's return address, or why there is none. */
  public static func answer(from callback: URL) throws -> Data {
    guard callback.scheme == scheme, callback.host == "passkey", let frag = callback.fragment, !frag.isEmpty else { throw noAnswer }
    if frag.hasPrefix("error=") { throw noAnswer }
    guard let d = unb64url(frag), (try? JSONSerialization.jsonObject(with: d)) is [String: Any] else { throw noAnswer }
    return d
  }

  static func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func unb64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }
}

/** One signed-in device of the account (Settings › Security). */
public struct Device: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let device: String
  public let created_at: Int64
  public let last_seen: Int64
  public let current: Bool
  public let indexer: Bool

  public var name: String { device.isEmpty ? "Unknown device" : device }

  public static func list(api: API) async throws -> [Device] {
    struct L: Decodable { let sessions: [Device] }
    return try await api.get(L.self, "/api/me/sessions").sessions
  }

  /** Signs that device out: its next request fails and it deletes what it keeps of the library. */
  public static func signOut(api: API, id: String) async throws {
    guard id.utf8.count == 24, id.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
      throw APIError(status: -1, message: "That device can't be signed out from here.")
    }
    _ = try await api.json("DELETE", "/api/me/sessions/\(id)")
  }

  public static func signOutOthers(api: API) async throws {
    _ = try await api.json("POST", "/api/me/sessions/end-others")
  }
}

/** Something the account's devices show once (a new sign-in, two-step sign-in turned off by an admin, the password used
 *  for a sign-in that wasn't finished, a change to two-step sign-in made on another of its devices). Dismissing it
 *  on any device dismisses it everywhere. */
public struct Notice: Decodable, Sendable, Equatable, Identifiable {
  public let id: Int64
  public let kind: String
  public let device: String
  public let at: Int64

  public init(id: Int64, kind: String, device: String, at: Int64) { self.id = id; self.kind = kind; self.device = device; self.at = at }

  public static let kinds: Set<String> = ["sign_in", "2fa_reset", "password_used", "totp_added", "totp_removed",
                                           "passkey_added", "passkey_removed", "recovery_codes", "2fa_off"]
  public var date: Date { Date(timeIntervalSince1970: TimeInterval(at)) }
  /** a sign-in notice leads to the device list */
  public var reviewDevices: Bool { kind == "sign_in" }
  /** the banner has a button to Settings (the devices, or two-step sign-in); the password is changed in the browser */
  public var opensSettings: Bool { kind != "password_used" }

  /** What the banner says; time is the moment as the app shows it. */
  public func text(time: String) -> String {
    let on = device.isEmpty ? "an unknown device" : device
    switch kind {
    case "sign_in": return "New sign-in: \(on), \(time). Not you? Review devices."
    case "password_used": return "Your password was used to start a sign-in that wasn't finished (\(time)). Not you? Change your password in Cipherfilm in the browser."
    case "totp_added": return "An authenticator app was added to two-step sign-in on \(on), \(time). Not you?"
    case "totp_removed": return "The authenticator app was removed from two-step sign-in on \(on), \(time). Not you?"
    case "passkey_added": return "A passkey was added to two-step sign-in on \(on), \(time). Not you?"
    case "passkey_removed": return "A passkey was removed from two-step sign-in on \(on), \(time). Not you?"
    case "recovery_codes": return "New recovery codes were made on \(on), \(time); the old ones no longer work. Not you?"
    case "2fa_off": return "Two-step sign-in was turned off on \(on), \(time). Not you?"
    default: return "An administrator turned off two-step sign-in for your account (\(time)). Turn it on again in Settings."
    }
  }

  /** Only the kinds this app knows, newest first (a newer server may add others). */
  public static func shown(_ list: [Notice]) -> [Notice] {
    list.filter { kinds.contains($0.kind) }.sorted { $0.id > $1.id }
  }

  public static func load(api: API, background: Bool = false) async throws -> [Notice] {
    struct L: Decodable { let notices: [Notice] }
    return shown(try JSONDecoder().decode(L.self, from: try await api.json("GET", "/api/me/notices", background: background)).notices)
  }

  public static func dismiss(api: API, id: Int64) async throws {
    _ = try await api.json("POST", "/api/me/notices/\(id)/dismiss")
  }
}

/**
 * Which notices this Mac also shows as a macOS notification, when its window isn't in front (the banner shows them
 * otherwise): each at most once. Every notice the app has seen is remembered (the newest `keep` ids, per server: ids
 * are the server's), whether it went out as a notification or was in the banner. Old ones (from before `recent`) are
 * only remembered: a Mac that was off for a week doesn't get a pile, the banner still shows them.
 */
public struct NoticeAlerts: Codable, Equatable, Sendable {
  public private(set) var server: String
  public private(set) var ids: [Int64]
  public static let recent: TimeInterval = 3 * 24 * 3600
  public static let keep = 200

  public init(server: String = "", ids: [Int64] = []) { self.server = server; self.ids = ids }

  /** The ones to post now, oldest first; all of list is remembered. visible: the window shows the banner. */
  public mutating func take(_ list: [Notice], server: String, now: Date, visible: Bool) -> [Notice] {
    if self.server != server { self.server = server; ids = [] }
    let known = Set(ids)
    let fresh = list.filter { !known.contains($0.id) }
    ids = Array(Set(ids).union(list.map(\.id))).sorted(by: >).prefix(Self.keep).map { $0 }
    if visible { return [] }
    return fresh.filter { $0.date >= now.addingTimeInterval(-Self.recent) }.sorted { ($0.at, $0.id) < ($1.at, $1.id) }
  }

  /** The notification's title; what the lock screen and hidden previews show (never the device or the time). */
  public static func title(_ n: Notice) -> String {
    switch n.kind {
    case "sign_in": return "New sign-in to Cipherfilm"
    case "2fa_reset", "2fa_off": return "Two-step sign-in turned off"
    case "totp_added", "totp_removed", "passkey_added", "passkey_removed": return "Two-step sign-in changed"
    case "recovery_codes": return "New recovery codes made"
    default: return "Unfinished sign-in to Cipherfilm"
    }
  }
}
