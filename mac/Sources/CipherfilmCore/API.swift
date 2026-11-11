// The server's JSON API, as the web and Android clients use it. The session is the server's `__Host-sid` cookie, kept
// in this app's own cookie store; the CSRF token comes with /api/me and lives in memory.
import Foundation
import SystemConfiguration

public struct APIError: Error, LocalizedError, Sendable {
  public let status: Int
  public let message: String
  /** the server's machine-readable reason, where it gives one ("not_indexer") */
  public let code: String?
  /** the token of a sign-in waiting for its two-step code ("two_factor_required"); nothing else carries one */
  public let pending: String?
  /** with a pending token: whether the account has an authenticator app and a passkey for this server (an older
   *  server says neither) */
  public let totp: Bool?
  public let passkey: Bool?
  public var errorDescription: String? { message }
  public static let offline = "Can't connect to the server. Check your connection and try again."
  public init(status: Int, message: String, code: String? = nil, pending: String? = nil, totp: Bool? = nil, passkey: Bool? = nil) {
    self.status = status; self.message = message; self.code = code; self.pending = pending; self.totp = totp; self.passkey = passkey
  }
}

/** The server's ids (accounts, items, albums): 16 random bytes in lowercase hex. An id goes into file names and
 *  request paths, so one of any other shape is refused. */
public enum ServerId {
  public static func valid(_ s: String) -> Bool {
    s.utf8.count == 32 && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }

  /** dir/id, only for an id that passes valid(): an id from the server becomes a path only this way. */
  public static func folder(in dir: URL, _ id: String) -> URL? {
    valid(id) ? dir.appendingPathComponent(id, isDirectory: true) : nil
  }
}

public struct Me: Codable, Sendable {
  public struct User: Codable, Sendable {
    public let id: String; public let email: String; public let role: String
    /** an admin allowed this person explicit search (docs/SEARCH.md) */
    public let nsfw: Bool?

    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      // the account's folders on this Mac are named by it
      guard ServerId.valid(id) else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not an account id") }
      email = try c.decode(String.self, forKey: .email)
      role = try c.decode(String.self, forKey: .role)
      nsfw = try c.decodeIfPresent(Bool.self, forKey: .nsfw)
    }
  }
  public let user: User
  public let csrf: String
  /** this device in the account's device list, and the one device that computes the search index ("" = none yet);
   *  both missing from servers before 1.9.0 (docs/SEARCH.md, "One device indexes") */
  public let session_id: String?
  public let indexer: String?
  public let kdf: KdfParams
  public let wrapped_master_pw: String
  public let wrapped_privkey: String
  public let pubkey: String
  /** shown in Settings; missing from servers before it was added */
  public let server_version: String?
  /** the server's public demo login (DEMO_ACCOUNTS): it reads and searches, every change is refused */
  public let demo: Bool?
  public var isDemo: Bool { demo == true }
  /** two-step sign-in is on for the account (missing from servers before it) */
  public let two_factor: Bool?
  /** The map tab's base map (docs/MAP.md, server/mapconf.go): MapLibre style URLs, tried in order. Missing when the
   *  operator turned the map off (MAP_STYLE=off) and from servers before the map. */
  public let map: MapStyles?

  public struct MapStyles: Codable, Sendable, Equatable {
    public let light: [String]
    public let dark: [String]

    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      // only https style URLs: the map's page allows exactly their hosts (MapPage.swift)
      func https(_ k: CodingKeys) throws -> [String] {
        try c.decode([String].self, forKey: k).filter { s in
          guard let u = URLComponents(string: s) else { return false }
          // a plain host name: it goes into the page's Content-Security-Policy
          let host = u.host ?? ""
          return u.scheme == "https" && !host.isEmpty && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
            && u.user == nil && u.password == nil
        }
      }
      light = try https(.light)
      dark = try https(.dark)
    }

    public init(light: [String], dark: [String]) { self.light = light; self.dark = dark }

    /** The origins the styles load from ("https://tiles.openfreemap.org"): a style takes its tiles, fonts and icons
     *  from its own host, as OpenFreeMap's and VersaTiles' do. */
    public var origins: [String] {
      Array(Set((light + dark).compactMap { URLComponents(string: $0).flatMap { u in u.host.map { h in "https://" + h + (u.port.map { ":\($0)" } ?? "") } } })).sorted()
    }
  }

  /** Whether the map tab is shown: the server sends a light and a dark style. */
  public var hasMap: Bool { !(map?.light.isEmpty ?? true) && !(map?.dark.isEmpty ?? true) }
  /** Shown wherever a demo login looks at its photos, so nobody takes it for their own library. */
  public static let demoNote = "Public demo · read-only · resets every hour"

  /** Whether this device may compute index entries: it is the indexer, or there is none yet (the first that writes
   *  one becomes it). */
  public var mayIndex: Bool { (indexer ?? "").isEmpty || indexer == session_id }
}

public final class API: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  public let base: URL
  private let lock = NSLock()
  private var _csrf = ""
  public var csrf: String {
    get { lock.withLock { _csrf } }
    set { lock.withLock { _csrf = newValue } }
  }
  /** Called when the server says the session is gone (401 outside sign-in); revoked: this device was signed out
   *  from another one (the server says so with `X-CF-Session: revoked`), otherwise it expired. */
  public var onSessionEnded: (@Sendable (_ revoked: Bool) -> Void)?
  private let cookies: HTTPCookieStorage
  /** The name the account's device list shows for this Mac ("Studio (Mac app)"), sent with every request. ASCII only:
   *  a header value outside it (an umlaut in the computer's name) can make the request fail before it is sent. */
  public static let device: String = {
    let raw = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ""
    let name = String(String.UnicodeScalarView(raw.unicodeScalars.filter { $0.value >= 0x20 && $0.value < 0x7f }))
      .split(separator: " ").joined(separator: " ")
    return (name.isEmpty ? "" : name + " ") + "(Mac app)"
  }()
  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.default
    c.httpAdditionalHeaders = ["X-CF-Device": Self.device]
    c.httpCookieStorage = cookies
    c.httpShouldSetCookies = true
    c.httpCookieAcceptPolicy = .always
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.timeoutIntervalForRequest = 30
    c.timeoutIntervalForResource = 600
    c.httpMaximumConnectionsPerHost = 8
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()
  /** The live-update stream's own: no overall time limit (it stays open while the app runs, which the other session's
   *  ten minutes would end), and a connection that sends nothing for 70 s (the server's heartbeat comes every 25)
   *  counts as dropped. Same cookies and device name. */
  private lazy var eventSession: URLSession = {
    let c = URLSessionConfiguration.default
    c.httpAdditionalHeaders = ["X-CF-Device": Self.device]
    c.httpCookieStorage = cookies
    c.httpShouldSetCookies = true
    c.httpCookieAcceptPolicy = .always
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.timeoutIntervalForRequest = 70
    c.timeoutIntervalForResource = 7 * 24 * 3600
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()
  private var eventsUsed = false

  /** cookies: another store than the app's makes a separate signed-in device (the debug driver's second device). */
  public init(base: URL, cookies: HTTPCookieStorage = .shared) { self.base = base; self.cookies = cookies }

  /** An address as typed: https is required (the session cookie is `Secure`). */
  public static func origin(_ input: String) throws -> URL {
    var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
    guard var c = URLComponents(string: s), c.host?.isEmpty == false else { throw APIError(status: -1, message: "That isn't a web address.") }
    guard c.scheme?.lowercased() == "https" else { throw APIError(status: -1, message: "Cipherfilm needs an https address.") }
    c.path = ""; c.query = nil; c.fragment = nil
    return c.url!
  }

  private static let friendly: [String: String] = [
    "invalid request": "That didn't work. Check what you entered and try again.",
    "server error": "The server had a problem. Wait a moment and try again.",
    "not found": "That couldn't be found. It may have been removed.",
  ]
  private static func sentence(_ s: String) -> String {
    if let f = friendly[s] { return f }
    guard let first = s.first else { return s }
    let t = first.uppercased() + s.dropFirst()
    return t.hasSuffix(".") || t.hasSuffix("!") || t.hasSuffix("?") ? t : t + "."
  }

  private func url(_ path: String) -> URL { URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)! }

  private func ended(_ h: HTTPURLResponse, _ path: String) {
    if h.statusCode == 401 && !path.hasPrefix("/api/auth/") && path != "/api/me" { onSessionEnded?(Self.revoked(h)) }
  }

  static func revoked(_ h: HTTPURLResponse) -> Bool { h.statusCode == 401 && h.value(forHTTPHeaderField: "X-CF-Session") == "revoked" }

  private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      let (d, r) = try await session.data(for: req)
      guard let h = r as? HTTPURLResponse else { throw APIError(status: 0, message: APIError.offline) }
      return (d, h)
    } catch let e as APIError {
      throw e
    } catch {
      if error is CancellationError { throw CancellationError() }
      if let u = error as? URLError {
        switch u.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
             .clientCertificateRejected, .secureConnectionFailed, .cancelled:
          throw APIError(status: -2, message: "The server's certificate isn't trusted by this Mac, so Cipherfilm didn't connect.")
        case .cannotFindHost, .dnsLookupFailed:
          throw APIError(status: 0, message: "That server name can't be found. Check the address (and that Tailscale or your VPN is connected, if you use one).")
        default: throw APIError(status: 0, message: Self.network(u))
        }
      }
      throw APIError(status: 0, message: APIError.offline)
    }
  }

  /** What went wrong on the way to the server, in words: a slow connection is not one that can't be made. All of these
   *  count as offline (status 0) for retrying. */
  static func network(_ u: URLError) -> String {
    switch u.code {
    case .timedOut: return "The server is slow to answer (the connection is slow or busy)."
    case .networkConnectionLost: return "The connection to the server dropped."
    case .notConnectedToInternet: return "This Mac is offline."
    case .cannotConnectToHost: return "The server isn't answering. Check that it is running (and that Tailscale or your VPN is connected, if you use one)."
    case .dataNotAllowed, .internationalRoamingOff: return "This Mac isn't allowed to use the network right now."
    default: return APIError.offline
    }
  }

  private func failure(_ d: Data, _ status: Int, fallback: String) -> APIError {
    let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    // a body that isn't the server's JSON (a proxy's error page, or a server too old for this request) gets the status
    let fb = obj == nil ? "The server answered \(status)\(status == 404 ? " (not found; the server may be older than this app)" : status == 502 || status == 504 ? " (the server behind the proxy isn't answering)" : "")." : fallback
    return APIError(status: status, message: Self.sentence(obj?["error"] as? String ?? fb), code: obj?["code"] as? String, pending: obj?["pending"] as? String,
                    totp: obj?["totp"] as? Bool, passkey: obj?["passkey"] as? Bool)
  }

  /** A JSON request; body is encoded with JSONSerialization or Encodable. */
  @discardableResult
  /** timeout: how long the answer may pause (not its whole time); a minute, since a tailnet relay that a model download
   *  fills may hold a small request back for a while. */
  public func json(_ method: String, _ path: String, body: Any? = nil, timeout: TimeInterval = 60) async throws -> Data {
    var r = URLRequest(url: url(path), timeoutInterval: timeout)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try (body as? Data) ?? JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes])
    }
    if method != "GET", !csrf.isEmpty { r.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
    let (d, h) = try await send(r)
    guard (200..<300).contains(h.statusCode) else {
      ended(h, path)
      if Self.revoked(h) { throw APIError(status: 401, message: "This Mac was signed out from another device.", code: "revoked") }
      throw failure(d, h.statusCode, fallback: "Something went wrong.")
    }
    return d
  }

  public func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
    try JSONDecoder().decode(T.self, from: try await json("GET", path))
  }

  private static let retryable: Set<Int> = [0, 408, 429, 500, 502, 503, 504]

  /** PUT ciphertext, retrying network drops and busy servers with backoff; other 4xx fail at once. */
  public func putBytes(_ path: String, _ bytes: Data, tries: Int = 5) async throws {
    var last = APIError(status: 0, message: APIError.offline)
    for i in 0..<tries {
      if i > 0 { try await Task.sleep(nanoseconds: UInt64(1_000_000_000) << UInt64(i - 1)) }
      var r = URLRequest(url: url(path), timeoutInterval: 120)
      r.httpMethod = "PUT"
      r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      r.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
      r.httpBody = bytes
      do {
        let (d, h) = try await send(r)
        if (200..<300).contains(h.statusCode) { return }
        ended(h, path)
        last = failure(d, h.statusCode, fallback: "Something went wrong.")
        if !Self.retryable.contains(h.statusCode) { break }
      } catch let e as APIError {
        last = e
      }
    }
    throw last
  }

  public func getBytes(_ path: String) async throws -> Data {
    var r = URLRequest(url: url(path), timeoutInterval: 120)
    r.httpMethod = "GET"
    let (d, h) = try await send(r)
    guard (200..<300).contains(h.statusCode) else { ended(h, path); throw APIError(status: h.statusCode, message: "Couldn't load this item.") }
    return d
  }

  /** For the search models, from Hugging Face: nothing of this app or account goes along (no cookie, no device
   *  header, no cache), and no overall time limit (hundreds of MB on a slow line); a connection that sends nothing for
   *  a minute counts as dropped and is resumed. */
  private static let modelSession: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.timeoutIntervalForRequest = 60
    c.timeoutIntervalForResource = 7 * 24 * 3600
    return URLSession(configuration: c, delegate: HTTPSRedirects(), delegateQueue: nil)
  }()

  /** Hugging Face answers with a redirect to its CDN: followed only to https, with the Range header kept. */
  private final class HTTPSRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
      guard request.url?.scheme?.lowercased() == "https" else { return nil }
      var r = request
      if let range = task.originalRequest?.value(forHTTPHeaderField: "Range") { r.setValue(range, forHTTPHeaderField: "Range") }
      return r
    }
  }

  public enum DownloadEvent: Sendable {
    /** bytes in the file so far (also those from before a drop) */
    case bytes(Int64)
    /** the connection dropped; the next try (with Range, from where it stopped) is in that many seconds */
    case retrying(in: Int, reason: String)
  }

  /** Downloads a search model from its pinned https URL into `file`, resuming with HTTP Range what an earlier try or
   *  run left there. Drops, stalls and busy servers are retried with backoff (up to a minute between tries) until it is
   *  done or cancelled, each wait reported with its reason; refusals (403, 404) fail at once. With `expected`, a
   *  complete file returns without a request, and an answer longer than that fails at once (the file is deleted)
   *  instead of filling the disk. */
  public static func download(_ source: URL, to file: URL, expected: Int64? = nil, event: @escaping @Sendable (DownloadEvent) -> Void) async throws {
    struct Refused: Error { let error: APIError }
    guard source.scheme?.lowercased() == "https" else { throw APIError(status: -1, message: "Search models are only downloaded over https.") }
    let tooLong = Refused(error: APIError(status: -1, message: "The search models couldn't be downloaded (Hugging Face sent more than expected)."))
    var fruitless = 0
    while true {
      try Task.checkCancellation()
      var have = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
      if let expected, have > expected { try? FileManager.default.removeItem(at: file); have = 0 }
      if let expected, have == expected { event(.bytes(have)); return }
      let before = have
      var got = have
      do {
        var r = URLRequest(url: source, timeoutInterval: 60)
        if have > 0 { r.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        let (bytes, resp) = try await modelSession.bytes(for: r)
        guard let h = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if h.statusCode == 416 { try? FileManager.default.removeItem(at: file); throw URLError(.networkConnectionLost) } // the file changed: from the start
        guard h.statusCode == 200 || h.statusCode == 206 else {
          let e = APIError(status: h.statusCode, message: "The search models couldn't be downloaded (Hugging Face answered \(h.statusCode)).")
          if Self.retryable.contains(h.statusCode) { throw e }
          throw Refused(error: e)
        }
        if let expected {
          let len = h.expectedContentLength // -1: not announced
          if len > (h.statusCode == 200 ? expected : expected - have) { try? FileManager.default.removeItem(at: file); throw tooLong }
        }
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        let fh = try FileHandle(forWritingTo: file)
        defer { try? fh.close() }
        if h.statusCode == 200 { try fh.truncate(atOffset: 0); got = 0 } else { try fh.seekToEnd() } // 200: the server ignored Range
        event(.bytes(got))
        var buf = Data(capacity: 256 << 10)
        let limit = expected ?? .max
        do {
          for try await b in bytes {
            buf.append(b)
            if got + Int64(buf.count) > limit { try? fh.close(); try? FileManager.default.removeItem(at: file); throw tooLong }
            if buf.count >= 256 << 10 { try fh.write(contentsOf: buf); got += Int64(buf.count); buf.removeAll(keepingCapacity: true); event(.bytes(got)) }
          }
        } catch let r as Refused {
          throw r
        } catch {
          // keep what arrived: the next try asks for the rest
          try? fh.write(contentsOf: buf); got += Int64(buf.count); event(.bytes(got))
          throw error
        }
        try fh.write(contentsOf: buf); got += Int64(buf.count); event(.bytes(got))
        if let expected, got < expected { throw URLError(.networkConnectionLost) }
        return
      } catch let r as Refused {
        throw r.error
      } catch {
        if Task.isCancelled || error is CancellationError { throw CancellationError() }
        fruitless = got > before ? 1 : fruitless + 1
        let wait = min(60, 1 << min(fruitless, 6)) // 2, 4, 8 … 60 s; a drop after progress starts again at 2 s
        var reason = (error as? APIError)?.message ?? ((error as? URLError)?.code == .timedOut ? "The download stalled (no data for a minute)." : (error as? URLError).map(Self.modelNetwork) ?? "The connection dropped.")
        if fruitless > 3 { reason += " No data for the last \(fruitless - 1) tries." }
        event(.retrying(in: wait, reason: reason))
        try await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000_000)
      }
    }
  }

  private static func modelNetwork(_ u: URLError) -> String {
    switch u.code {
    case .timedOut: return "Hugging Face is slow to answer (the connection is slow or busy)."
    case .networkConnectionLost: return "The connection to Hugging Face dropped."
    case .cannotFindHost, .cannotConnectToHost: return "Hugging Face can't be reached."
    default: return network(u)
    }
  }

  /** Signs this app out of the server's cookie store for this address. */
  public func clearCookies() {
    let store = cookies
    for c in store.cookies(for: base) ?? [] { store.deleteCookie(c) }
  }

  public func invalidate() {
    session.invalidateAndCancel()
    if lock.withLock({ eventsUsed }) { eventSession.invalidateAndCancel() }
  }

  /** Reads the live-update stream (Live.swift) until the server ends it, the task is cancelled or `handle` returns
   *  false. Throws when it can't be opened or drops; a 401 ends the session as with any other request. */
  public func events(_ handle: @Sendable (LiveSignal) async -> Bool) async throws {
    var r = URLRequest(url: url("/api/events"), timeoutInterval: 70)
    r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    lock.withLock { eventsUsed = true }
    let bytes: URLSession.AsyncBytes, resp: URLResponse
    do {
      (bytes, resp) = try await eventSession.bytes(for: r)
    } catch {
      if error is CancellationError || Task.isCancelled { throw CancellationError() }
      throw APIError(status: 0, message: APIError.offline)
    }
    guard let h = resp as? HTTPURLResponse else { throw APIError(status: 0, message: APIError.offline) }
    guard h.statusCode == 200 else {
      ended(h, "/api/events")
      throw APIError(status: h.statusCode, message: "The server didn't open the live updates (\(h.statusCode)).")
    }
    var parser = SSEParser()
    for try await b in bytes {
      if let e = parser.feed(b), let s = LiveSignal(e), !(await handle(s)) { return }
      if parser.overflowed { throw APIError(status: 0, message: APIError.offline) } // the caller connects again
    }
  }

  // ---- TLS: the system's trust, plus (debug builds only) a test CA for the local test server ----

  public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    #if DEBUG
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust,
       let test = TestCA.current, test.covers(challenge.protectionSpace.host) {
      SecTrustSetAnchorCertificates(trust, [test.cert] as CFArray)
      SecTrustSetAnchorCertificatesOnly(trust, true)
      SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, (test.host ?? challenge.protectionSpace.host) as CFString))
      if SecTrustEvaluateWithError(trust, nil) { return (.useCredential, URLCredential(trust: trust)) }
      return (.cancelAuthenticationChallenge, nil)
    }
    #endif
    return (.performDefaultHandling, nil)
  }

  /** The same for a single task: the long-download session's streams ask here. */
  public func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    await urlSession(session, didReceive: challenge)
  }
}

#if DEBUG
/** Debug builds only: CF_TEST_CA (a PEM file; or the CFTestCA default) lets the app talk to the throwaway test server of
 *  mobile/dev/compose.yaml at https://localhost:8443. Release builds trust the system's certificates only. */
public struct TestCA: @unchecked Sendable {
  let cert: SecCertificate
  let host: String?
  public static let current: TestCA? = {
    let env = ProcessInfo.processInfo.environment
    guard let path = env["CF_TEST_CA"] ?? UserDefaults.standard.string(forKey: "CFTestCA"),
          let pem = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    let b64 = pem.components(separatedBy: "\n").filter { !$0.hasPrefix("-----") }.joined()
    guard let der = Data(base64Encoded: b64), let cert = SecCertificateCreateWithData(nil, der as CFData) else { return nil }
    return TestCA(cert: cert, host: env["CF_TEST_HOST"])
  }()

  /** Only the throwaway server on this Mac (or the emulator's name for it); every other server gets the system's trust. */
  func covers(_ h: String) -> Bool { ["localhost", "127.0.0.1", "::1", "10.0.2.2"].contains(h.lowercased()) || h == host }
}
#endif

public enum Account {
  /** Sign-in: the server's KDF settings for the address, then the password's auth key. Returns the session and master
   *  key, or, for an account with two-step sign-in, the code step (the server sent no session and no keys yet). */
  public static func login(api: API, email: String, password: String) async throws -> SignIn {
    let e = Crypto.normEmail(email)
    let kdf = try await api.get(KdfParams.self, "/api/auth/params?email=" + (e.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? e))
    try Crypto.assertSaneKdf(kdf)
    var (auth, kek) = try Crypto.deriveFromPassword(password, kdf)
    defer { Sodium.memzero(&auth); Sodium.memzero(&kek) }
    let body: Data
    do {
      body = try await api.json("POST", "/api/auth/login", body: ["email": e, "auth": B64.encode(auth)])
    } catch let err as APIError {
      if let step = CodeStep(err, email: e, kek: kek) { return .code(step) }
      throw err
    }
    let me = try JSONDecoder().decode(Me.self, from: body)
    api.csrf = me.csrf
    return .done(me, try Crypto.unlockMasterKey(email: e, kek: kek, wrappedMasterPw: me.wrapped_master_pw))
  }

  /** The second step of a sign-in: the code from the authenticator app or a recovery code. A wrong code may be tried
   *  again with the same step; an expired one (APIError code "two_factor_expired") needs the password again. */
  public static func finish(api: API, step: CodeStep, code: String) async throws -> (Me, Data) {
    try await finish(api: api, step: step, second: ["code": TwoFactor.clean(code)])
  }

  /** The challenge for a passkey (server/passkeys.go), bound to this sign-in: the options for the browser. */
  public static func passkeyChallenge(api: API, step: CodeStep) async throws -> Data {
    guard step.key != nil else { throw CodeStep.expiredError }
    do {
      return try await Passkeys.options(try await api.json("POST", "/api/auth/login/2fa/passkey", body: ["pending": step.pending]))
    } catch let err as APIError where err.code == "two_factor_expired" {
      step.abandon(); throw CodeStep.expiredError
    }
  }

  /** The same step with a passkey's answer (JSON) to that challenge. */
  public static func finish(api: API, step: CodeStep, passkey answer: Data) async throws -> (Me, Data) {
    guard let obj = try? JSONSerialization.jsonObject(with: answer) as? [String: Any] else { throw Passkeys.noAnswer }
    return try await finish(api: api, step: step, second: ["passkey": obj])
  }

  private static func finish(api: API, step: CodeStep, second: [String: Any]) async throws -> (Me, Data) {
    guard let kek = step.key else { throw CodeStep.expiredError }
    let body: Data
    do {
      body = try await api.json("POST", "/api/auth/login/2fa", body: second.merging(["pending": step.pending]) { a, _ in a })
    } catch let err as APIError {
      if err.code == "two_factor_expired" { step.abandon(); throw CodeStep.expiredError }
      if err.code == "wrong_code" { throw APIError(status: err.status, message: TwoFactor.wrongCode, code: err.code) }
      if err.code == "wrong_passkey" { throw APIError(status: err.status, message: Passkeys.wrongPasskey, code: err.code) }
      throw err
    }
    let me = try JSONDecoder().decode(Me.self, from: body)
    api.csrf = me.csrf
    defer { step.abandon() }
    return (me, try Crypto.unlockMasterKey(email: step.email, kek: kek, wrappedMasterPw: me.wrapped_master_pw))
  }

  /** The password's auth key (the proof the server checks for account changes), after checking the password here
   *  first: a typo shows before anything is sent. */
  public static func proof(me: Me, password: String) throws -> String {
    try Crypto.assertSaneKdf(me.kdf)
    var (auth, kek) = try Crypto.deriveFromPassword(password, me.kdf)
    defer { Sodium.memzero(&auth); Sodium.memzero(&kek) }
    do { var key = try Crypto.unlockMasterKey(email: me.user.email, kek: kek, wrappedMasterPw: me.wrapped_master_pw); Sodium.memzero(&key) } catch {
      throw APIError(status: -1, message: "That password isn't right.")
    }
    return B64.encode(auth)
  }

  /** After a restart the session cookie is still valid: only the password is needed for the keys. */
  public static func unlock(me: Me, password: String) throws -> Data {
    try Crypto.assertSaneKdf(me.kdf)
    var (auth, kek) = try Crypto.deriveFromPassword(password, me.kdf)
    defer { Sodium.memzero(&auth); Sodium.memzero(&kek) }
    do { return try Crypto.unlockMasterKey(email: me.user.email, kek: kek, wrappedMasterPw: me.wrapped_master_pw) } catch {
      throw APIError(status: -1, message: "That password isn't right.")
    }
  }

  /** Deletes the account and everything in it on the server, permanently, after checking the password here first (a
   *  typo shows before anything is sent). The server refuses for its only administrator. */
  public static func delete(api: API, me: Me, password: String) async throws {
    try Crypto.assertSaneKdf(me.kdf)
    var (auth, kek) = try Crypto.deriveFromPassword(password, me.kdf)
    defer { Sodium.memzero(&auth); Sodium.memzero(&kek) }
    do { var key = try Crypto.unlockMasterKey(email: me.user.email, kek: kek, wrappedMasterPw: me.wrapped_master_pw); Sodium.memzero(&key) } catch {
      throw APIError(status: -1, message: "That password isn't right.")
    }
    _ = try await api.json("DELETE", "/api/me", body: ["current_auth": B64.encode(auth)])
  }

  /** A master key is only accepted if it opens something the server keeps sealed under it. */
  public static func keyFits(me: Me, key: Data) -> Bool {
    (try? Crypto.open(B64.decode(me.wrapped_privkey), key: key, label: Label.privkey, owner: Crypto.normEmail(me.user.email))) != nil
  }
}
