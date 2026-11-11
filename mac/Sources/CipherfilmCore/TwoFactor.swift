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
  }

  public struct Setup: Decodable, Sendable, Equatable {
    public let secret: String
    /** otpauth://totp/…: what the QR code holds */
    public let uri: String
  }

  struct Codes: Decodable { let recovery_codes: [String] }

  public static func status(api: API) async throws -> Status { try await api.get(Status.self, "/api/me/2fa") }

  /** A new secret to show (not on until a code from it is confirmed). */
  public static func setup(api: API, me: Me, password: String) async throws -> Setup {
    let proof = try Account.proof(me: me, password: password)
    return try JSONDecoder().decode(Setup.self, from: try await api.json("POST", "/api/me/2fa/setup", body: ["current_auth": proof]))
  }

  /** Turns it on with a code from the new secret; returns the ten recovery codes, shown only now. */
  public static func enable(api: API, code: String) async throws -> [String] {
    try JSONDecoder().decode(Codes.self, from: try await friendly { try await api.json("POST", "/api/me/2fa/enable", body: ["code": clean(code)]) }).recovery_codes
  }

  public static func disable(api: API, me: Me, password: String, code: String) async throws {
    let proof = try Account.proof(me: me, password: password)
    _ = try await friendly { try await api.json("POST", "/api/me/2fa/disable", body: ["current_auth": proof, "code": clean(code)]) }
  }

  /** New recovery codes; the old ones stop working. */
  public static func newCodes(api: API, me: Me, password: String, code: String) async throws -> [String] {
    let proof = try Account.proof(me: me, password: password)
    return try JSONDecoder().decode(Codes.self, from: try await friendly { try await api.json("POST", "/api/me/2fa/recovery-codes", body: ["current_auth": proof, "code": clean(code)]) }).recovery_codes
  }

  private static func friendly(_ f: () async throws -> Data) async throws -> Data {
    do { return try await f() } catch let e as APIError where e.code == "wrong_code" {
      throw APIError(status: e.status, message: wrongCode, code: e.code)
    }
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
 *  for a sign-in that wasn't finished). Dismissing it
 *  on any device dismisses it everywhere. */
public struct Notice: Decodable, Sendable, Equatable, Identifiable {
  public let id: Int64
  public let kind: String
  public let device: String
  public let at: Int64

  public init(id: Int64, kind: String, device: String, at: Int64) { self.id = id; self.kind = kind; self.device = device; self.at = at }

  public static let kinds: Set<String> = ["sign_in", "2fa_reset", "password_used"]
  public var date: Date { Date(timeIntervalSince1970: TimeInterval(at)) }
  /** a sign-in notice leads to the device list */
  public var reviewDevices: Bool { kind == "sign_in" }
  /** the banner has a button to Settings (the devices, or two-step sign-in); the password is changed in the browser */
  public var opensSettings: Bool { kind != "password_used" }

  /** What the banner says; time is the moment as the app shows it. */
  public func text(time: String) -> String {
    switch kind {
    case "sign_in": return "New sign-in: \(device.isEmpty ? "an unknown device" : device), \(time). Not you? Review devices."
    case "password_used": return "Your password was used to start a sign-in that wasn't finished (\(time)). Not you? Change your password in Cipherfilm in the browser."
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
    case "2fa_reset": return "Two-step sign-in turned off"
    default: return "Unfinished sign-in to Cipherfilm"
    }
  }
}
