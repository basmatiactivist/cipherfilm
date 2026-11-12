// Administration (Settings › Administration, admins only): the same requests and capabilities as the web app's Admin
// area (web/src/screens.tsx) and Android's (mobile/src/admin.ts). The server decides who may do what
// (server/handlers_admin.go, admin_ext.go): every /api/admin/ request from a non-admin, and from the public demo login,
// is answered "not found", whatever this app shows. Invites need no crypto here: the invited person makes their keys
// when they open the link in the browser.
import Foundation

public enum Admin {
  public struct User: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let email: String
    public let role: String
    public let status: String
    public let created_at: Int64
    public let last_login_at: Int64
    public let quota_bytes: Int64
    public let used_bytes: Int64
    public let item_count: Int
    public let nsfw: Bool
    public let two_factor: Bool?

    public var isAdmin: Bool { role == "admin" }
    public var isActive: Bool { status == "active" }
  }

  public struct Invite: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let email: String
    public let expires_at: Int64
    public let quota_bytes: Int64
  }

  public struct Accounts: Decodable, Sendable, Equatable {
    public let users: [User]
    public let invites: [Invite]
    public let default_quota_bytes: Int64
  }

  public struct Entry: Decodable, Sendable, Equatable {
    public let at: Int64
    public let actor: String
    public let action: String
    public let target: String
    public let detail: String
    public init(at: Int64, actor: String, action: String, target: String, detail: String) {
      self.at = at; self.actor = actor; self.action = action; self.target = target; self.detail = detail
    }
  }

  public struct Status: Decodable, Sendable, Equatable {
    public let disk_free_bytes: Int64
    public let disk_total_bytes: Int64
    public let data_bytes: Int64
    public let active_sessions: Int
    public let last_backup_at: Int64
    public let uptime_seconds: Int64
    public let version: String?
    public let backup_ok_at: Int64?
    public let backup_failed_at: Int64?
    public let backup_failed_in: String?
  }

  /** The invite as created: the link is shown once (the server keeps only its hash). */
  public struct NewInvite: Sendable, Equatable {
    public let link: String
    public let email: String
    public let expires: Date
  }

  /** Whether to offer Administration. Only a hint for the window: the server checks every request itself. */
  public static func offered(_ me: Me?) -> Bool { me.map { $0.user.role == "admin" && !$0.isDemo } ?? false }

  /** A refused request: this account is no admin (any more). The server says "not found" for that. */
  public static func noAccess(_ e: Error) -> Bool {
    guard let a = e as? APIError else { return false }
    return a.status == 403 || a.status == 404
  }

  // ---- requests ----

  /** What an admin changes about one person. Disabling also signs out all their devices (the server does it). */
  public enum Change: Sendable, Equatable {
    case enabled(Bool), admin(Bool), explicit(Bool), limit(Int64)
  }

  /** Every admin request, as method, path and body: exactly what the web sends. Ids are checked before they become
   *  part of a path. */
  public enum Action: Sendable, Equatable {
    case change(String, Change)
    case delete(String)
    case resetTwoStep(String)
    case revokeInvite(String)
    case defaultLimit(Int64)
    case invite(email: String, limit: Int64?)
  }

  public static func request(_ a: Action) throws -> (method: String, path: String, body: [String: Any]?) {
    func id(_ s: String) throws -> String {
      guard ServerId.valid(s) else { throw APIError(status: -1, message: "That couldn't be found. It may have been removed.") }
      return s
    }
    switch a {
    case let .change(u, c):
      let body: [String: Any]
      switch c {
      case .enabled(let on): body = ["status": on ? "active" : "disabled"]
      case .admin(let on): body = ["role": on ? "admin" : "user"]
      case .explicit(let on): body = ["nsfw": on]
      case .limit(let b): body = ["quota_bytes": b]
      }
      return ("PATCH", "/api/admin/users/\(try id(u))", body)
    case .delete(let u): return ("DELETE", "/api/admin/users/\(try id(u))", nil)
    case .resetTwoStep(let u): return ("DELETE", "/api/admin/users/\(try id(u))/2fa", nil)
    case .revokeInvite(let i): return ("DELETE", "/api/admin/invites/\(try id(i))", nil)
    case .defaultLimit(let b): return ("PATCH", "/api/admin/settings", ["default_quota_bytes": b])
    case let .invite(email, limit):
      var body: [String: Any] = ["email": email.trimmingCharacters(in: .whitespacesAndNewlines)]
      if let limit { body["quota_bytes"] = limit }
      return ("POST", "/api/admin/invites", body)
    }
  }

  @discardableResult
  public static func run(api: API, _ a: Action) async throws -> Data {
    let r = try request(a)
    return try await api.json(r.method, r.path, body: r.body)
  }

  public static func accounts(api: API) async throws -> Accounts { try await api.get(Accounts.self, "/api/admin/users") }
  public static func status(api: API) async throws -> Status { try await api.get(Status.self, "/api/admin/status") }
  public static func activity(api: API) async throws -> [Entry] {
    struct L: Decodable { let entries: [Entry] }
    return try await api.get(L.self, "/api/admin/audit").entries
  }

  /** Creates an invite; gb as typed ("" = the server's default). */
  public static func invite(api: API, email: String, gb: String) async throws -> NewInvite {
    struct R: Decodable { let token: String; let email: String; let expires_at: Int64 }
    let r = try JSONDecoder().decode(R.self, from: try await run(api: api, .invite(email: email, limit: try parseGB(gb, optional: true))))
    return NewInvite(link: link(origin: api.base, token: r.token), email: r.email, expires: Date(timeIntervalSince1970: TimeInterval(r.expires_at)))
  }

  /** The link the invited person opens in the browser: the server's own address, as the web makes it. */
  public static func link(origin: URL, token: String) -> String {
    let o = origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return o + "/invite/" + (token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? token)
  }

  // ---- wording (the web's) ----

  public static let limitError = "Enter the storage limit as a number of GB (0 means no limit)."

  /** A storage limit as typed, in GB, to bytes. 0 = no limit; empty is "not given" where that is allowed. */
  public static func parseGB(_ s: String, optional: Bool = false) throws -> Int64? {
    let v = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
    if v.isEmpty && optional { return nil }
    guard let n = Double(v), n.isFinite, n >= 0, n <= 1_000_000 else { throw APIError(status: -1, message: limitError) }
    return Int64((n * 1e9).rounded())
  }

  /** A limit as the editor shows it, in GB: decimals kept (21.5, not 21), so saving it unchanged keeps it. */
  public static func gbText(_ n: Int64) -> String {
    var t = String(format: "%.3f", Double(n) / 1e9)
    while t.hasSuffix("0") { t.removeLast() }
    if t.hasSuffix(".") { t.removeLast() }
    return t
  }

  public static func size(_ n: Int64) -> String {
    if n >= 1_000_000_000 { return String(format: "%.1f GB", Double(n) / 1e9) }
    if n >= 1_000_000 { return String(format: "%.0f MB", Double(n) / 1e6) }
    return n > 0 ? "less than 1 MB" : "0 MB"
  }

  public static func limit(_ n: Int64) -> String { n == 0 ? "no limit" : size(n) }

  public static func usage(_ u: User) -> String {
    let items = u.item_count == 1 ? "1 item" : "\(u.item_count) items"
    return (u.quota_bytes == 0 ? "\(size(u.used_bytes)) used, no limit" : "\(size(u.used_bytes)) of \(size(u.quota_bytes))") + " · " + items
  }

  public static func summary(_ users: [User]) -> String {
    let stored = users.reduce(Int64(0)) { $0 + $1.used_bytes }, items = users.reduce(0) { $0 + $1.item_count }
    return "\(users.count) \(users.count == 1 ? "person" : "people") · \(size(stored)) stored · \(items) \(items == 1 ? "item" : "items")"
  }

  public static func lastSeen(_ ts: Int64, now: Date = Date()) -> String {
    if ts == 0 { return "never signed in" }
    let d = Int(floor((now.timeIntervalSince1970 - Double(ts)) / 86400))
    return d <= 0 ? "active today" : d == 1 ? "active yesterday" : "active \(d) days ago"
  }

  public static func badges(_ u: User) -> [String] {
    [u.role, u.isActive ? "" : u.status, u.nsfw ? "explicit search" : "", u.two_factor == true ? "two-step sign-in" : ""].filter { !$0.isEmpty }
  }

  public static func uptime(_ s: Int64) -> String {
    let (n, unit) = s >= 86400 ? (s / 86400, "day") : s >= 3600 ? (s / 3600, "hour") : (s / 60, "minute")
    return n == 1 ? "1 \(unit)" : "\(n) \(unit)s"
  }

  /** The off-site backup as the operator's backup tool last reported it (web/src/backup.ts); problem is the warning. */
  public static func backup(_ s: Status, now: Date = Date()) -> (text: String, problem: String?) {
    let ok = s.backup_ok_at ?? 0, failed = s.backup_failed_at ?? 0
    let when = { (t: Int64) in Date(timeIntervalSince1970: TimeInterval(t)).formatted(date: .abbreviated, time: .shortened) }
    if ok == 0 && failed == 0 { return ("Nothing reported. Your backup tool can report its result here with cipherfilm backup-report (docs/SELF-HOSTING.md).", nil) }
    if failed > ok {
      let step = s.backup_failed_in == "snapshot" ? "the database snapshot couldn't be written" : "the backup tool couldn't save to the backup target"
      let p = "The last off-site backup failed on \(when(failed)): \(step). " + (ok > 0 ? "Last successful one: \(when(ok))." : "None has succeeded yet.")
      return (p, p)
    }
    if now.timeIntervalSince1970 - Double(ok) > 36 * 3600 {
      let p = "No off-site backup since \(when(ok)). The backup has stopped or isn't reporting."
      return (p, p)
    }
    return ("\(when(ok)), successful", nil)
  }

  /** One activity entry as a sentence ("You made a@x.org an administrator"), as the web says it; warn: worth a look. */
  public static func describe(_ a: Entry, me: String) -> (symbol: String, text: String, warn: Bool) {
    func subject(_ e: String) -> String { e == me ? "You" : e == "server console" ? "The server console" : e == "a deleted account" ? "A deleted account" : e }
    func object(_ e: String) -> String { e == me ? "you" : e == "server console" ? "the server console" : e }
    let who = subject(a.actor), t = object(a.target)
    switch a.action {
    case "invited": return ("plus", "\(who) invited \(t)", false)
    case "joined": return ("person", "\(subject(a.target)) joined", false)
    case "invite revoked": return ("xmark", "\(who) withdrew the invite for \(t)", false)
    case "role changed": return ("shield", "\(who) made \(t) \(a.detail == "admin" ? "an administrator" : "a regular user")", false)
    case "explicit search allowed": return ("magnifyingglass", "\(who) allowed explicit search for \(t)", false)
    case "explicit search turned off": return ("magnifyingglass", "\(who) turned off explicit search for \(t)", false)
    case "enabled": return ("checkmark", "\(who) enabled \(t)", false)
    case "disabled": return ("nosign", "\(who) disabled \(t)", true)
    case "deleted": return ("trash", "\(who) deleted \(t) and everything they stored", true)
    case "storage limit changed": return ("externaldrive", "\(who) set the storage limit of \(t) to \(limit(Int64(a.detail) ?? 0))", false)
    case "default limit changed": return ("externaldrive", "\(who) set the default storage limit to \(limit(Int64(a.detail) ?? 0))", false)
    case "signed out a device": return ("rectangle.portrait.and.arrow.right", "\(who) signed out \(a.detail.isEmpty ? "a device" : a.detail)", false)
    case "signed out other devices": return ("rectangle.portrait.and.arrow.right", "\(who) signed out all other devices", false)
    case "two-step sign-in turned off": return ("key", "\(who) turned off two-step sign-in for \(t)", true)
    case "turned on two-step sign-in": return ("key", "\(who) turned on two-step sign-in", false)
    case "turned off two-step sign-in": return ("key", "\(who) turned off two-step sign-in", false)
    case "made new recovery codes": return ("key", "\(who) made new recovery codes", false)
    case "signed out every device":
      return ("rectangle.portrait.and.arrow.right", "\(who) signed out every device of \(t)" + (a.detail.isEmpty ? "" : ", and they delete what they keep"), !a.detail.isEmpty)
    default:
      return ("info.circle", [who, a.action, a.target.isEmpty ? "" : "· \(t)", a.detail.isEmpty ? "" : "(\(a.detail))"].filter { !$0.isEmpty }.joined(separator: " "), false)
    }
  }

  /** A day heading: Today, Yesterday, or the date. */
  public static func day(_ at: Int64, now: Date = Date(), calendar: Calendar = .current) -> String {
    let d = Date(timeIntervalSince1970: TimeInterval(at))
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: d), to: calendar.startOfDay(for: now)).day ?? 0
    if days == 0 { return "Today" }
    if days == 1 { return "Yesterday" }
    let sameYear = calendar.component(.year, from: d) == calendar.component(.year, from: now)
    return d.formatted(sameYear ? .dateTime.weekday(.wide).day().month(.wide) : .dateTime.weekday(.wide).day().month(.wide).year())
  }

  public static func byDay(_ list: [Entry], now: Date = Date(), calendar: Calendar = .current) -> [(day: String, entries: [Entry])] {
    var out: [(day: String, entries: [Entry])] = []
    for e in list {
      let d = day(e.at, now: now, calendar: calendar)
      if let last = out.last, last.day == d { out[out.count - 1].entries.append(e) } else { out.append((d, [e])) }
    }
    return out
  }
}
