// A WebDAV folder as an import source (docs/MAC.md "Import from a WebDAV folder"): its listing (one PROPFIND, Depth 1,
// flat: subfolders are counted, never entered) and its files' bytes by HTTP Range requests, so a file is read piece by
// piece as it is encrypted and never lands on this Mac whole. The server only sees this Mac list the folder and read
// files; the password is answered to its own challenge (Basic or Digest) and kept in memory for the session only;
// TLS is checked by macOS as for any other connection, and redirects to another host or to http are refused.
import Foundation

public enum WebDAVError: Error, LocalizedError, Equatable, Sendable {
  case address(String)
  case unauthorized
  case notFound
  case notWebDAV
  case certificate
  case offline
  case status(Int)
  /** the server answered a Range request with the whole file */
  case noRanges
  /** the file changed (size or ETag) since it was listed */
  case changed
  case malformed
  /** not enough free space on this Mac for a temporary copy (DiskBudget) */
  case diskFull

  public var errorDescription: String? {
    switch self {
    case .address(let s): return s
    case .unauthorized: return "The user name or password is wrong."
    case .notFound: return "The folder or file isn't there (anymore)."
    case .notWebDAV: return "This address doesn't answer as a WebDAV folder."
    case .certificate: return "The server's certificate isn't trusted, so nothing was sent to it."
    case .offline: return "Can't reach the WebDAV server. Trying again later."
    case .status(let s): return "The WebDAV server answered with an error (\(s))."
    case .noRanges: return "The WebDAV server doesn't send parts of files."
    case .changed: return "The file changed on the server while it was being read."
    case .malformed: return "The WebDAV server's answer couldn't be read."
    case .diskFull: return "Not enough free space on this Mac for the next large file. Free up some space; the import goes on by itself."
    }
  }

  var isAddress: Bool { if case .address = self { return true } else { return false } }

  /** The server or the way to it rather than one file: the pass ends and is tried again later, no file counts as failed. */
  public var transient: Bool {
    switch self {
    case .offline, .unauthorized, .certificate, .diskFull, .address: return true
    case .status(let s): return s == 408 || s == 429 || s >= 500
    default: return false
    }
  }
}

/** Which WebDAV addresses are accepted. https always; http only to this Mac or a private network address (the
 *  password would cross the network readable), and the settings say so next to it. No user name or password inside the
 *  address, no query or fragment. */
public enum WebDAVAddress {
  public enum Check: Equatable, Sendable {
    case ok(URL)
    /** http to this Mac or a private network: allowed, with a warning */
    case unencrypted(URL)
    case invalid(String)
  }

  public static func check(_ input: String) -> Check {
    let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return .invalid("Enter the folder's address.") }
    guard var c = URLComponents(string: t), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty else {
      return .invalid("Enter the folder's full address, starting with https://.")
    }
    guard scheme == "https" || scheme == "http" else { return .invalid("Only https:// addresses can be used.") }
    guard c.user == nil, c.password == nil else { return .invalid("Put the user name and password in their own fields, not in the address.") }
    guard c.query == nil, c.fragment == nil else { return .invalid("The address can't contain ? or #.") }
    c.scheme = scheme
    if !c.path.hasSuffix("/") { c.path += "/" } // a folder: its members resolve inside it
    guard let url = c.url else { return .invalid("Enter the folder's full address, starting with https://.") }
    if scheme == "https" { return .ok(url) }
    return isPrivate(host) ? .unencrypted(url) : .invalid("Only https:// addresses can be used, except for this Mac or a home network.")
  }

  /** This Mac, a private (RFC 1918, link-local, CGNAT as tailnets use, unique-local IPv6) address or a local name.
   *  Decided from the spelling: an address only in its plain form (four decimal numbers, no leading zeros; IPv6 as
   *  written), and a number in any other spelling (2130706433, 0x7f000001, 0177.0.0.1, 10.1) is never taken for a
   *  name. Before anything is sent over http the name is also looked up (resolvesPrivately). */
  public static func isPrivate(_ hostIn: String) -> Bool {
    let host = hostIn.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host.hasSuffix(".localhost") { return true }
    for s in [".local", ".lan", ".home.arpa", ".internal"] where host.hasSuffix(s) { return true }
    if let a = ipv4(host) { return isPrivate(v4: a) }
    if host.contains(":") { return ipv6(host).map { isPrivate(v6: $0) } ?? false }
    // the last label of a name is never a number; one that is is an address in an odd spelling
    let last = host.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? host
    if last.range(of: #"^([0-9]+|0x[0-9a-f]*)$"#, options: .regularExpression) != nil { return false }
    // a single name without dots (a NAS's name on the home network)
    return !host.contains(".") && host.range(of: #"^[a-z0-9-]+$"#, options: .regularExpression) != nil
  }

  /** Four decimal numbers 0…255 without leading zeros, nothing else. */
  static func ipv4(_ s: String) -> [UInt8]? {
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var out: [UInt8] = []
    for p in parts {
      guard (1...3).contains(p.count), p.allSatisfy({ ("0"..."9").contains($0) }), p == "0" || !p.hasPrefix("0"), let n = UInt8(p) else { return nil }
      out.append(n)
    }
    return out
  }

  static func ipv6(_ s: String) -> [UInt8]? {
    let plain = s.split(separator: "%", maxSplits: 1).first.map(String.init) ?? s // a zone (fe80::1%en0)
    var a = in6_addr()
    guard inet_pton(AF_INET6, plain, &a) == 1 else { return nil }
    return withUnsafeBytes(of: &a) { Array($0) }
  }

  static func isPrivate(v4 n: [UInt8]) -> Bool {
    switch (n[0], n[1]) {
    case (127, _), (10, _), (192, 168), (169, 254): return true
    case (172, 16...31): return true
    case (100, 64...127): return true
    default: return false
    }
  }

  /** ::1, unique-local fc00::/7, link-local fe80::/10, and an IPv4 one written as IPv6 (::ffff:a.b.c.d). */
  static func isPrivate(v6 b: [UInt8]) -> Bool {
    if b == [UInt8](repeating: 0, count: 15) + [1] { return true }
    if b[0] & 0xfe == 0xfc { return true }
    if b[0] == 0xfe, b[1] & 0xc0 == 0x80 { return true }
    if b[0..<10].allSatisfy({ $0 == 0 }), b[10] == 0xff, b[11] == 0xff { return isPrivate(v4: Array(b[12..<16])) }
    return false
  }

  /** Whether every address the name leads to is this Mac, a private network or, for IPv6, the same /64 network as one
   *  of this Mac's own (a home network's global IPv6 addresses). A name that can't be looked up counts as not private.
   *  Blocking: call off the main thread. */
  public static func resolvesPrivately(_ hostIn: String) -> Bool {
    let host = hostIn.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    var hints = addrinfo()
    hints.ai_socktype = SOCK_STREAM
    var res: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &res) == 0, let first = res else { return false }
    defer { freeaddrinfo(first) }
    let own = ownV6Networks()
    var any = false
    var p: UnsafeMutablePointer<addrinfo>? = first
    while let a = p {
      defer { p = a.pointee.ai_next }
      guard let sa = a.pointee.ai_addr else { continue }
      switch Int32(sa.pointee.sa_family) {
      case AF_INET:
        let b = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { s in withUnsafeBytes(of: s.pointee.sin_addr) { Array($0) } }
        guard isPrivate(v4: b) else { return false }
      case AF_INET6:
        let b = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { s in withUnsafeBytes(of: s.pointee.sin6_addr) { Array($0) } }
        guard isPrivate(v6: b) || own.contains(Array(b[0..<8])) else { return false }
      default: return false
      }
      any = true
    }
    return any
  }

  /** The /64 networks of this Mac's own global IPv6 addresses. */
  static func ownV6Networks() -> Set<[UInt8]> {
    var out = Set<[UInt8]>()
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return out }
    defer { freeifaddrs(first) }
    var p: UnsafeMutablePointer<ifaddrs>? = first
    while let i = p {
      defer { p = i.pointee.ifa_next }
      guard let sa = i.pointee.ifa_addr, Int32(sa.pointee.sa_family) == AF_INET6 else { continue }
      let b = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { s in withUnsafeBytes(of: s.pointee.sin6_addr) { Array($0) } }
      if b[0] & 0xe0 == 0x20 { out.insert(Array(b[0..<8])) } // global unicast 2000::/3
    }
    return out
  }
}

/** One member of the folder, from its PROPFIND answer. */
public struct WebDAVEntry: Sendable, Equatable, Codable {
  public var name: String
  /** the member's own address on the server */
  public var url: URL
  public var size: Int64
  public var etag: String?
  public var modified: Date?
  public var contentType: String?
  public var isFolder: Bool

  public init(name: String, url: URL, size: Int64, etag: String? = nil, modified: Date? = nil, contentType: String? = nil, isFolder: Bool = false) {
    self.name = name; self.url = url; self.size = size; self.etag = etag; self.modified = modified; self.contentType = contentType; self.isFolder = isFolder
  }
}

public struct WebDAVListing: Sendable, Equatable {
  /** the files directly in the folder (hidden ones left out) */
  public var files: [WebDAVEntry]
  /** subfolders, counted and left alone */
  public var folders: Int
}

public enum PropFind {
  public static let body = Data("""
    <?xml version="1.0" encoding="utf-8"?>
    <d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>
    """.utf8)

  /** The folder's direct members from a 207 Multi-Status answer. Namespace prefixes don't matter (D:, d:, lp1:, none);
   *  only properties in a propstat with a 2xx status count (servers list unknown ones under 404). The folder itself,
   *  hidden files, members of other folders or hosts, and names that aren't one path component are left out. */
  public static func parse(_ data: Data, folder: URL) throws -> WebDAVListing {
    let p = Parser()
    let x = XMLParser(data: data)
    x.shouldProcessNamespaces = true
    x.shouldResolveExternalEntities = false
    x.delegate = p
    guard x.parse() else { throw WebDAVError.malformed }
    var files: [WebDAVEntry] = [], folders = 0
    let base = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
    for r in p.responses {
      guard let href = r.href?.trimmingCharacters(in: .whitespacesAndNewlines), !href.isEmpty,
            let u = URL(string: href, relativeTo: folder)?.absoluteURL ?? href.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed).flatMap({ URL(string: $0, relativeTo: folder)?.absoluteURL })
      else { continue }
      // the same server (an absolute href may name it), directly inside the folder
      guard u.scheme?.lowercased() == folder.scheme?.lowercased(), u.host?.lowercased() == folder.host?.lowercased(),
            (u.port ?? defaultPort(u)) == (folder.port ?? defaultPort(folder)) else { continue }
      let path = u.path(percentEncoded: false)
      let dir = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
      if dir + "/" == base || dir == base || path == base { continue } // the folder itself
      let parent = (dir as NSString).deletingLastPathComponent
      guard (parent.hasSuffix("/") ? parent : parent + "/") == base else { continue }
      let name = (dir as NSString).lastPathComponent
      guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\u{0}") else { continue }
      if r.collection || r.href?.hasSuffix("/") == true && r.length == nil { folders += 1; continue }
      if name.hasPrefix(".") { continue }
      // a size no file can have is a listing that can't be trusted for this member: left out
      if let n = r.length, n < 0 { continue }
      files.append(WebDAVEntry(name: name, url: u, size: r.length ?? 0, etag: r.etag, modified: r.modified.flatMap(httpDate),
                               contentType: r.contentType, isFolder: false))
    }
    return WebDAVListing(files: files.sorted { $0.name < $1.name }, folders: folders)
  }

  static func defaultPort(_ u: URL) -> Int { u.scheme == "http" ? 80 : 443 }

  /** RFC 1123 ("Sat, 14 Nov 2026 10:00:00 GMT"), as WebDAV says; some servers send RFC 850, asctime or ISO 8601. */
  public static func httpDate(_ s: String) -> Date? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    for fmt in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM d HH:mm:ss yyyy"] {
      let f = DateFormatter()
      f.locale = Locale(identifier: "en_US_POSIX")
      f.timeZone = TimeZone(identifier: "GMT")
      f.dateFormat = fmt
      if let d = f.date(from: t) { return d }
    }
    return ISO8601DateFormatter().date(from: t)
  }

  final class Parser: NSObject, XMLParserDelegate {
    struct Response { var href: String?; var collection = false; var length: Int64?; var etag: String?; var modified: String?; var contentType: String? }
    struct Props { var collection = false; var length: Int64?; var etag: String?; var modified: String?; var contentType: String? }
    var responses: [Response] = []
    private var cur: Response?
    private var props: Props?
    private var status: String?
    private var text = ""
    private var inProp = false
    private var depth = 0

    func parser(_ parser: XMLParser, didStartElement el: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
      depth += 1
      guard depth < 64 else { parser.abortParsing(); return }
      text = ""
      switch el {
      case "response": cur = Response()
      case "propstat": props = Props(); status = nil
      case "prop": inProp = true
      case "collection": if inProp { props?.collection = true }
      default: break
      }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
      if text.count < 8192 { text += string }
    }

    func parser(_ parser: XMLParser, didEndElement el: String, namespaceURI: String?, qualifiedName: String?) {
      depth -= 1
      let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
      switch el {
      case "href": if cur != nil, !inProp, cur?.href == nil { cur?.href = t }
      case "getcontentlength": if inProp { props?.length = Int64(t) }
      case "getetag": if inProp, !t.isEmpty { props?.etag = t }
      case "getlastmodified": if inProp, !t.isEmpty { props?.modified = t }
      case "getcontenttype": if inProp, !t.isEmpty { props?.contentType = t }
      case "prop": inProp = false
      case "status": if props != nil, !inProp { status = t }
      case "propstat":
        // "HTTP/1.1 200 OK"; a propstat without a status is taken as found
        let code = status.flatMap { $0.split(separator: " ").dropFirst().first.flatMap { Int($0) } } ?? 200
        if let p = props, (200..<300).contains(code) {
          if p.collection { cur?.collection = true }
          if let v = p.length { cur?.length = v }
          if let v = p.etag { cur?.etag = v }
          if let v = p.modified { cur?.modified = v }
          if let v = p.contentType { cur?.contentType = v }
        }
        props = nil
      case "response":
        if let c = cur { responses.append(c) }
        cur = nil
      default: break
      }
      text = ""
    }
  }
}

/** Talks to one WebDAV folder. Its own ephemeral session: no cookies, no cache, nothing written to disk; the credential
 *  lives in this session's memory only. */
public final class WebDAVClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  public let folder: URL
  private let user: String
  private let password: String
  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.httpCookieAcceptPolicy = .never
    c.httpShouldSetCookies = false
    c.timeoutIntervalForRequest = 60
    c.timeoutIntervalForResource = 3600
    c.httpMaximumConnectionsPerHost = 8
    c.urlCredentialStorage = nil
    if !protocols.isEmpty { c.protocolClasses = protocols + (c.protocolClasses ?? []) }
    sessionMade = true
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()
  /** whether `session` exists (a client that never sent anything doesn't make one on its way out) */
  private var sessionMade = false
  private let protocols: [AnyClass]
  /** bytes read from the server, for the import's speed and the tests' measurements */
  public let received = Counter()

  /** folder: an address WebDAVAddress accepted. protocols: tests only. */
  public init(folder: URL, user: String, password: String, protocols: [AnyClass] = []) {
    self.folder = folder; self.user = user; self.password = password; self.protocols = protocols
  }

  deinit { if sessionMade { session.invalidateAndCancel() } }
  public func invalidate() { if sessionMade { session.invalidateAndCancel() } }

  /** The folder's members (one PROPFIND, Depth 1). */
  public func list() async throws -> WebDAVListing {
    var r = URLRequest(url: folder, timeoutInterval: 120)
    r.httpMethod = "PROPFIND"
    r.setValue("1", forHTTPHeaderField: "Depth")
    r.setValue("application/xml; charset=utf-8", forHTTPHeaderField: "Content-Type")
    r.httpBody = PropFind.body
    let (bytes, h) = try await open(r)
    switch h.statusCode {
    case 207:
      let d = try await body(bytes, h, cap: Self.listingCap, tooLong: .malformed)
      return try PropFind.parse(d, folder: h.url.map { Self.sameFolder($0, folder) } ?? folder)
    case 200, 405, 501: bytes.task.cancel(); throw WebDAVError.notWebDAV
    default: bytes.task.cancel(); throw Self.failure(h.statusCode)
    }
  }

  /** A folder listing larger than this is refused (one of 100,000 files takes far less). */
  public static let listingCap = 64 << 20

  /** A redirect may have added the slash; the listing is still read against the folder that was asked for. */
  static func sameFolder(_ u: URL, _ folder: URL) -> URL { u.host == folder.host && u.port == folder.port && u.scheme == folder.scheme ? u : folder }

  /** The bytes [offset, offset + len) of a file, by a Range request; tried again a few times when the connection drops,
   *  from where it was. Refuses an answer for another version of the file (size or ETag changed). */
  public func read(_ e: WebDAVEntry, offset: Int64, len: Int) async throws -> Data {
    guard len > 0 else { return Data() }
    guard offset >= 0, offset + Int64(len) <= e.size else { throw WebDAVError.changed }
    var last: Error = WebDAVError.offline
    for attempt in 0..<4 {
      if attempt > 0 { try await Task.sleep(nanoseconds: UInt64(500_000_000) << UInt64(attempt - 1)) }
      try Task.checkCancellation()
      var r = URLRequest(url: e.url, timeoutInterval: 60)
      r.httpMethod = "GET"
      r.setValue("bytes=\(offset)-\(offset + Int64(len) - 1)", forHTTPHeaderField: "Range")
      r.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
      if let et = e.etag, !et.hasPrefix("W/") { r.setValue(et, forHTTPHeaderField: "If-Range") }
      do {
        // never more than was asked for is taken in: a longer answer stops the transfer
        let (bytes, h) = try await open(r)
        switch h.statusCode {
        case 206:
          // Content-Range: bytes a-b/total
          if let cr = h.value(forHTTPHeaderField: "Content-Range"), let total = cr.split(separator: "/").last.flatMap({ Int64($0) }), total != e.size {
            bytes.task.cancel()
            throw WebDAVError.changed
          }
          let d = try await body(bytes, h, cap: len, tooLong: .changed)
          guard d.count == len else { throw WebDAVError.changed }
          return d
        case 200:
          // the whole file: fine when that is what was asked for, otherwise the server ignores ranges (or the file
          // changed), found out without reading it
          if offset == 0, Int64(len) == e.size {
            let d = try await body(bytes, h, cap: len, tooLong: .changed)
            guard d.count == len else { throw WebDAVError.changed }
            return d
          }
          bytes.task.cancel()
          if h.expectedContentLength >= 0, h.expectedContentLength != e.size { throw WebDAVError.changed }
          rangeLock.withLock { rangesKnown = false }
          throw WebDAVError.noRanges
        case 412, 416: bytes.task.cancel(); throw WebDAVError.changed
        default: bytes.task.cancel(); throw Self.failure(h.statusCode)
        }
      } catch let w as WebDAVError where w.transient && w != .unauthorized && w != .certificate && !w.isAddress {
        last = w
      }
    }
    throw last
  }

  private let rangeLock = NSLock()
  private var rangesKnown: Bool?

  /** What sendsRanges found out, nil before. */
  public var knownToSendRanges: Bool? { rangeLock.withLock { rangesKnown } }

  /** Whether the server sends parts of files: asked once, with a small Range request whose answer is dropped unread if
   *  it is the whole file. */
  public func sendsRanges(_ e: WebDAVEntry) async throws -> Bool {
    if let k = rangeLock.withLock({ rangesKnown }) { return k }
    guard e.size > 1 else { return true }
    var r = URLRequest(url: e.url, timeoutInterval: 60)
    r.httpMethod = "GET"
    r.setValue("bytes=0-0", forHTTPHeaderField: "Range")
    r.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let (bytes, h) = try await open(r)
    bytes.task.cancel()
    let ok: Bool
    switch h.statusCode {
    case 206: ok = true
    case 200: ok = false
    default: throw Self.failure(h.statusCode)
    }
    rangeLock.withLock { rangesKnown = ok }
    return ok
  }

  /** The whole file into a file of this Mac's own (only for a server that sends no parts), written straight there.
   *  Never more than the listed size is written: a longer answer stops the transfer and leaves no file. */
  public func download(_ e: WebDAVEntry, to dest: URL) async throws {
    var r = URLRequest(url: e.url, timeoutInterval: 120)
    r.httpMethod = "GET"
    r.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let (bytes, h) = try await open(r)
    guard h.statusCode == 200 else { bytes.task.cancel(); throw Self.failure(h.statusCode) }
    if h.expectedContentLength >= 0, h.expectedContentLength != e.size { bytes.task.cancel(); throw WebDAVError.changed }
    let fm = FileManager.default
    try? fm.removeItem(at: dest)
    guard fm.createFile(atPath: dest.path, contents: nil, attributes: [.posixPermissions: 0o600]), let fh = try? FileHandle(forWritingTo: dest) else {
      bytes.task.cancel()
      throw APIError(status: -1, message: "No room for a temporary copy.")
    }
    var done = false
    defer { try? fh.close(); if !done { try? fm.removeItem(at: dest) } }
    let chunk = 1 << 20
    var buf = [UInt8](), got: Int64 = 0
    buf.reserveCapacity(chunk)
    func flush() throws {
      guard got + Int64(buf.count) <= e.size else { bytes.task.cancel(); throw WebDAVError.changed }
      try fh.write(contentsOf: buf)
      got += Int64(buf.count)
      _ = received.add(Int64(buf.count))
      buf.removeAll(keepingCapacity: true)
    }
    do {
      for try await b in bytes {
        buf.append(b)
        if buf.count >= chunk || got + Int64(buf.count) > e.size { try flush() }
      }
      try flush()
    } catch let w as WebDAVError { throw w } catch let a as APIError { throw a } catch { throw Self.mapped(error) }
    guard got == e.size else { throw WebDAVError.changed }
    done = true
  }

  private let plainLock = NSLock()
  private var plainChecked: Date?

  /** Over http, the folder's name must still lead only to this Mac or a private network, looked up before anything
   *  (the password included) is sent, and again after a minute. https needs no look-up. */
  func checkPlain() async throws {
    guard folder.scheme?.lowercased() == "http" else { return }
    if let t = plainLock.withLock({ plainChecked }), Date().timeIntervalSince(t) < 60 { return }
    let host = folder.host ?? ""
    let ok = await Task.detached { WebDAVAddress.isPrivate(host) && WebDAVAddress.resolvesPrivately(host) }.value
    guard ok else { throw WebDAVError.address("This address doesn't lead to this Mac or a home network, so nothing is sent to it without https://.") }
    plainLock.withLock { plainChecked = Date() }
  }

  private func open(_ r: URLRequest) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
    try await checkPlain()
    let (bytes, resp): (URLSession.AsyncBytes, URLResponse)
    do { (bytes, resp) = try await session.bytes(for: r) } catch { throw Self.mapped(error) }
    guard let h = resp as? HTTPURLResponse else { bytes.task.cancel(); throw WebDAVError.malformed }
    return (bytes, h)
  }

  /** An answer's body, refused (and the transfer stopped) as soon as it would pass `cap` bytes. */
  private func body(_ bytes: URLSession.AsyncBytes, _ h: HTTPURLResponse, cap: Int, tooLong: WebDAVError) async throws -> Data {
    if h.expectedContentLength > Int64(cap) { bytes.task.cancel(); throw tooLong }
    var d = [UInt8]()
    d.reserveCapacity(h.expectedContentLength > 0 ? Int(h.expectedContentLength) : min(cap, 1 << 20))
    do {
      for try await b in bytes {
        guard d.count < cap else { bytes.task.cancel(); throw tooLong }
        d.append(b)
      }
    } catch let w as WebDAVError { throw w } catch { throw Self.mapped(error) }
    _ = received.add(Int64(d.count))
    return Data(d)
  }

  static func mapped(_ error: Error) -> Error {
    if error is CancellationError { return error }
    let ns = error as NSError
    guard ns.domain == NSURLErrorDomain else { return error }
    switch ns.code {
    case NSURLErrorCancelled: return CancellationError()
    case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot,
         NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected, NSURLErrorSecureConnectionFailed:
      return WebDAVError.certificate
    case NSURLErrorUserAuthenticationRequired, NSURLErrorUserCancelledAuthentication: return WebDAVError.unauthorized
    default: return WebDAVError.offline
    }
  }

  static func failure(_ status: Int) -> WebDAVError {
    switch status {
    case 401, 403: return .unauthorized
    case 404, 410: return .notFound
    default: return .status(status)
    }
  }

  // ---- the session's delegate ----

  public func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                         completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let m = challenge.protectionSpace.authenticationMethod
    // the certificate: macOS's own check, never overridden
    if m == NSURLAuthenticationMethodServerTrust { completionHandler(.performDefaultHandling, nil); return }
    // the password only to the folder's own server, once per challenge (a wrong one isn't sent again and again)
    let space = challenge.protectionSpace
    guard m == NSURLAuthenticationMethodHTTPBasic || m == NSURLAuthenticationMethodHTTPDigest,
          space.protocol?.lowercased() == folder.scheme?.lowercased(),
          space.host.lowercased() == folder.host?.lowercased(), space.port == (folder.port ?? PropFind.defaultPort(folder)),
          challenge.previousFailureCount == 0, !user.isEmpty else {
      completionHandler(.rejectProtectionSpace, nil); return
    }
    completionHandler(.useCredential, URLCredential(user: user, password: password, persistence: .forSession))
  }

  /** Redirects only within the same server and scheme (never from https to http, never to another host). */
  public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                         newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    guard let to = request.url, to.scheme == folder.scheme, to.host?.lowercased() == folder.host?.lowercased(),
          (to.port ?? PropFind.defaultPort(to)) == (folder.port ?? PropFind.defaultPort(folder)) else { completionHandler(nil); return }
    // PROPFIND stays PROPFIND (URLSession would turn a 301/302 into a GET)
    var r = request
    if let orig = task.originalRequest, orig.httpMethod == "PROPFIND" {
      r.httpMethod = "PROPFIND"; r.httpBody = orig.httpBody
      for (k, v) in orig.allHTTPHeaderFields ?? [:] where r.value(forHTTPHeaderField: k) == nil { r.setValue(v, forHTTPHeaderField: k) }
    }
    completionHandler(r)
  }
}
