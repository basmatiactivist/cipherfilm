// The WebDAV import (WebDAV.swift, WebDAVImport.swift, RangedAsset.swift): listings from different servers, which
// addresses are accepted, what a pass imports, the bookkeeping that resumes it, and metadata from ranged reads.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import CipherfilmCore

@Suite struct WebDAVTests {
  let folder = URL(string: "https://nas.example.org/remote.php/dav/files/me/Camera%20Roll/")!

  // ---- PROPFIND answers ----

  /** Apache mod_dav: D: prefix, live properties in a namespace of their own (lp1), a 404 propstat for the rest. */
  @Test func apacheListing() throws {
    let xml = """
    <?xml version="1.0" encoding="utf-8"?>
    <D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">
    <D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">
    <D:href>/remote.php/dav/files/me/Camera%20Roll/</D:href>
    <D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype><lp1:getlastmodified>Sat, 14 Nov 2026 10:00:00 GMT</lp1:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response>
    <D:response xmlns:lp1="DAV:">
    <D:href>/remote.php/dav/files/me/Camera%20Roll/IMG%200001.JPG</D:href>
    <D:propstat><D:prop><lp1:resourcetype/><lp1:getcontentlength>123456</lp1:getcontentlength><lp1:getlastmodified>Sat, 14 Nov 2026 10:00:00 GMT</lp1:getlastmodified><lp1:getetag>"1e240-5f0"</lp1:getetag><D:getcontenttype>image/jpeg</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><D:quota-used-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
    </D:response>
    <D:response>
    <D:href>/remote.php/dav/files/me/Camera%20Roll/Holidays/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response>
    </D:multistatus>
    """
    let l = try PropFind.parse(Data(xml.utf8), folder: folder)
    #expect(l.folders == 1)
    #expect(l.files.count == 1)
    let f = try #require(l.files.first)
    #expect(f.name == "IMG 0001.JPG")
    #expect(f.size == 123456)
    #expect(f.etag == "\"1e240-5f0\"")
    #expect(f.contentType == "image/jpeg")
    #expect(f.modified == Date(timeIntervalSince1970: 1_794_650_400))
    #expect(f.url.absoluteString == "https://nas.example.org/remote.php/dav/files/me/Camera%20Roll/IMG%200001.JPG")
  }

  /** Nextcloud-like: d: prefix, absolute hrefs, other namespaces (oc:, nc:) mixed in; a default namespace, no prefix. */
  @Test func oddServers() throws {
    let xml = """
    <?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
     <d:response><d:href>https://nas.example.org/remote.php/dav/files/me/Camera%20Roll/</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:size>9</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
     <d:response><d:href>https://nas.example.org/remote.php/dav/files/me/Camera%20Roll/Gr%C3%BCezi.heic</d:href>
      <d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:resourcetype/><d:getetag>&quot;abc&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
     <d:response><d:href>https://evil.example.com/remote.php/dav/files/me/Camera%20Roll/x.jpg</d:href>
      <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
     <d:response><d:href>/remote.php/dav/files/me/Camera%20Roll/Sub/deep.jpg</d:href>
      <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
     <d:response><d:href>/remote.php/dav/files/me/Camera%20Roll/.DS_Store</d:href>
      <d:propstat><d:prop><d:getcontentlength>6148</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
     <d:response><d:href>/remote.php/dav/files/me/Camera%20Roll/..%2F..%2Fetc</d:href>
      <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>
    """
    let l = try PropFind.parse(Data(xml.utf8), folder: folder)
    #expect(l.files.map(\.name) == ["Grüezi.heic"])
    #expect(l.files.first?.etag == "\"abc\"")
    #expect(l.folders == 0)

    let plain = """
    <multistatus xmlns="DAV:"><response><href>/photos/a.mp4</href><propstat><status>HTTP/1.1 200 OK</status>
    <prop><getcontentlength>10</getcontentlength><getlastmodified>2026-11-14T10:00:00Z</getlastmodified><resourcetype></resourcetype></prop></propstat></response>
    <response><href>/photos/sub</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>
    """
    let p = try PropFind.parse(Data(plain.utf8), folder: URL(string: "http://localhost:8080/photos/")!)
    #expect(p.files.map(\.name) == ["a.mp4"])
    #expect(p.files.first?.modified == Date(timeIntervalSince1970: 1_794_650_400))
    #expect(p.folders == 1)
  }

  @Test func brokenXMLIsAnError() {
    #expect(throws: WebDAVError.malformed) { try PropFind.parse(Data("<d:multistatus xmlns:d=\"DAV:\"><d:response>".utf8), folder: folder) }
  }

  @Test func httpDates() {
    #expect(PropFind.httpDate("Sat, 14 Nov 2026 10:00:00 GMT") == Date(timeIntervalSince1970: 1_794_650_400))
    #expect(PropFind.httpDate("Saturday, 14-Nov-26 10:00:00 GMT") == Date(timeIntervalSince1970: 1_794_650_400))
    #expect(PropFind.httpDate("Sat Nov 14 10:00:00 2026") == Date(timeIntervalSince1970: 1_794_650_400))
    #expect(PropFind.httpDate("yesterday") == nil)
  }

  // ---- addresses ----

  @Test func addresses() {
    #expect(WebDAVAddress.check("https://nas.example.org/photos") == .ok(URL(string: "https://nas.example.org/photos/")!))
    #expect(WebDAVAddress.check("http://localhost:8080/dav/") == .unencrypted(URL(string: "http://localhost:8080/dav/")!))
    #expect(WebDAVAddress.check("http://192.168.1.20/dav") == .unencrypted(URL(string: "http://192.168.1.20/dav/")!))
    #expect(WebDAVAddress.check("http://nas.local/dav") == .unencrypted(URL(string: "http://nas.local/dav/")!))
    #expect(WebDAVAddress.check("http://100.97.1.2/dav") == .unencrypted(URL(string: "http://100.97.1.2/dav/")!))
    for bad in ["http://nas.example.org/dav", "ftp://nas.local/x", "https://me:pw@nas.example.org/", "https://nas.example.org/?a=1", "", "nas.example.org", "http://8.8.8.8/"] {
      if case .invalid = WebDAVAddress.check(bad) {} else { Issue.record("accepted \(bad)") }
    }
    #expect(WebDAVAddress.isPrivate("172.20.0.1"))
    #expect(!WebDAVAddress.isPrivate("172.32.0.1"))
    #expect(WebDAVAddress.isPrivate("[::1]"))
    #expect(WebDAVAddress.isPrivate("fd7a:115c:a1e0::1"))
    #expect(WebDAVAddress.isPrivate("fe80::1%25en0"))
    #expect(WebDAVAddress.isPrivate("::ffff:192.168.1.2"))
    #expect(!WebDAVAddress.isPrivate("fcb::1")) // 0fcb::, not unique-local
    #expect(!WebDAVAddress.isPrivate("2001:db8::1"))
    #expect(!WebDAVAddress.isPrivate("::ffff:8.8.8.8"))
    // numbers in other spellings are addresses a resolver may read as public ones, never names
    for odd in ["134744072", "0x08080808", "010.8.8.8", "0127.0.0.1", "127.1", "10.0.1", "192.168.001.002", "0x7f.0.0.1", "nas.0x1"] {
      #expect(!WebDAVAddress.isPrivate(odd), "\(odd)")
      if case .invalid = WebDAVAddress.check("http://\(odd)/dav") {} else { Issue.record("accepted http://\(odd)") }
    }
    #expect(WebDAVAddress.isPrivate("nas") && WebDAVAddress.isPrivate("nas-2") && WebDAVAddress.isPrivate("10.0.0.1"))
  }

  /** Over http the name is looked up too: this Mac's own names pass, a public address doesn't (no network needed). */
  @Test func plainHTTPNeedsAPrivateAddress() async throws {
    #expect(WebDAVAddress.resolvesPrivately("127.0.0.1"))
    #expect(WebDAVAddress.resolvesPrivately("localhost"))
    #expect(WebDAVAddress.resolvesPrivately("[::1]"))
    #expect(!WebDAVAddress.resolvesPrivately("8.8.8.8"))
    #expect(!WebDAVAddress.resolvesPrivately("2001:db8::1"))
    // a client for an http folder looks the name up before it sends anything
    let c = WebDAVClient(folder: URL(string: "http://8.8.8.8/dav/")!, user: "u", password: "p", protocols: [StubDAV.self])
    await #expect(throws: WebDAVError.address("This address doesn't lead to this Mac or a home network, so nothing is sent to it without https://.")) {
      try await c.checkPlain()
    }
    try await WebDAVClient(folder: URL(string: "http://127.0.0.1:9/dav/")!, user: "u", password: "p").checkPlain()
  }

  // ---- what a pass imports ----

  func entry(_ name: String, _ size: Int64, etag: String? = nil, modified: Date? = nil) -> WebDAVEntry {
    WebDAVEntry(name: name, url: folder.appendingPathComponent(name), size: size, etag: etag, modified: modified)
  }

  @Test func planSkipsDoneKnownAndUnsupported() {
    let book = ImportBook(file: nil)
    let done = entry("done.jpg", 10, etag: "\"1\"")
    book.markDone(done)
    let l = WebDAVListing(files: [
      done, entry("known.HEIC", 20), entry("b.mov", 30, modified: Date(timeIntervalSince1970: 200)),
      entry("a.jpg", 40, modified: Date(timeIntervalSince1970: 100)), entry("notes.txt", 5), entry("raw.CR3", 5),
    ], folders: 2)
    let p = WebDAVImport.plan(l, book: book, known: [Crypto.fingerprint(name: "known.HEIC", size: 20)])
    #expect(p.todo.map(\.name) == ["a.jpg", "b.mov"]) // oldest first
    #expect(p.bytes == 70)
    #expect(p.done == 1 && p.inLibrary == 1 && p.folders == 2 && p.files == 6)
    #expect(p.unsupported == ["notes.txt", "raw.CR3"])
  }

  /** Sizes are the server's word: impossible ones leave the member out, huge ones are summed without overflowing. */
  @Test func listedSizesNeverOverflowThePlan() throws {
    func resp(_ name: String, _ len: String) -> String {
      "<d:response><d:href>\(name.contains(":") ? name : "/p/" + name)</d:href><d:propstat><d:prop><d:getcontentlength>\(len)</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    }
    let xml = "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">" + resp("a.jpg", "9223372036854775807") + resp("b.jpg", "1")
      + resp("c.jpg", "9223372036854775807") + resp("neg.jpg", "-9223372036854775808") + resp("http://dav.example:443/p/clear.jpg", "1")
      + resp("ftp://dav.example/p/other.jpg", "1") + "</d:multistatus>"
    let l = try PropFind.parse(Data(xml.utf8), folder: URL(string: "https://dav.example/p/")!)
    #expect(l.files.map(\.name) == ["a.jpg", "b.jpg", "c.jpg"])
    let p = WebDAVImport.plan(l, book: ImportBook(file: nil), known: [])
    #expect(p.todo.count == 3)
    #expect(p.bytes == .max)
  }

  // ---- bookkeeping ----

  @Test func bookResumesAcrossRestarts() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-book-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let f = dir.appendingPathComponent("src.log")
    let t = Date(timeIntervalSince1970: 1000)
    do {
      let b = ImportBook(file: f)
      b.markDone(entry("a.jpg", 1, etag: "\"x\"", modified: t))
      b.markDone(entry("b.jpg", 2, modified: t))
      #expect(!b.failed(entry("c.jpg", 3), "nope"))
      #expect(!b.failed(entry("c.jpg", 3), "nope"))
      #expect(b.failed(entry("c.jpg", 3), "broken file"))
    }
    // a line cut short by a crash is ignored
    let h = try FileHandle(forWritingTo: f); try h.seekToEnd(); try h.write(contentsOf: Data("{\"op\":\"d\",\"n\":".utf8)); try h.close()
    let b = ImportBook(file: f)
    #expect(b.isDone(entry("a.jpg", 1, etag: "\"x\"", modified: t)))
    #expect(b.isDone(entry("a.jpg", 1, etag: "\"x\"", modified: Date()))) // same ETag
    #expect(b.isDone(entry("b.jpg", 2, etag: "\"new\"", modified: t))) // same time
    #expect(!b.isDone(entry("b.jpg", 2, etag: "\"new\"", modified: Date()))) // replaced
    #expect(!b.isDone(entry("a.jpg", 9, etag: "\"x\"", modified: t))) // other size
    #expect(b.givenUp.map(\.name) == ["c.jpg"] && b.givenUp.first?.why == "broken file")
    #expect(b.doneCount == 2)
    b.retryGivenUp()
    #expect(!b.isDone(entry("c.jpg", 3)))
    let again = ImportBook(file: f)
    #expect(again.givenUp.isEmpty && again.doneCount == 2)
    // compaction keeps the same state, one line per file
    again.compact()
    let lines = try String(contentsOf: f, encoding: .utf8).split(separator: "\n")
    #expect(lines.count == 2)
    #expect(ImportBook(file: f).isDone(entry("a.jpg", 1, etag: "\"x\"")))
    let perms = try FileManager.default.attributesOfItem(atPath: f.path)[.posixPermissions] as? Int
    #expect(perms == 0o600)
  }

  @Test func baselineCountsTheCurrentFilesAsDone() {
    let b = ImportBook(file: nil)
    b.baseline([entry("old.jpg", 1), entry("older.mp4", 2)])
    let p = WebDAVImport.plan(WebDAVListing(files: [entry("old.jpg", 1), entry("older.mp4", 2), entry("new.jpg", 3)], folders: 0), book: b, known: [])
    #expect(p.todo.map(\.name) == ["new.jpg"])
  }

  // ---- metadata from ranged reads ----

  /** A JPEG with a capture time, camera and GPS, as a phone writes it. */
  static func jpeg(width: Int = 64, height: Int = 48) -> Data {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.4, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let out = NSMutableData()
    let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, ctx.makeImage()!, [
      kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2024:07:14 18:03:22", kCGImagePropertyExifOffsetTimeOriginal: "+02:00"],
      kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Phone", kCGImagePropertyTIFFModel: "Model 1"],
      kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 47.3769, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 8.5417, kCGImagePropertyGPSLongitudeRef: "E"],
    ] as CFDictionary)
    CGImageDestinationFinalize(dst)
    return out as Data
  }

  @Test func photoMetadataFromMemory() throws {
    let i = Media.info(data: Self.jpeg())
    #expect(i.captureTs == 1_720_973_002_000)
    #expect(i.make == "Phone" && i.model == "Model 1")
    #expect(abs((i.lat ?? 0) - 47.3769) < 1e-6 && abs((i.lon ?? 0) - 8.5417) < 1e-6)
    #expect(i.width == 64 && i.height == 48)
    let t = try #require(Media.jpeg(data: Self.jpeg(width: 1200, height: 800), maxPx: Media.thumbPx, quality: 0.8))
    #expect(t.width == 640 && t.height == 427)
  }

  /** Reads of an in-memory file, counted, as the WebDAV client would make them. */
  final class Ranged: @unchecked Sendable {
    let data: Data
    let lock = NSLock()
    var reads: [(Int64, Int)] = []
    init(_ d: Data) { data = d }
    func read(_ o: Int64, _ n: Int) async throws -> Data {
      lock.withLock { reads.append((o, n)) }
      let end = min(data.count, Int(o) + n)
      return Int(o) < end ? data.subdata(in: Int(o)..<end) : Data()
    }
    var bytes: Int { lock.withLock { reads.reduce(0) { $0 + $1.1 } } }
  }

  @Test func videoDateAndFrameThroughRanges() async throws {
    let r = Ranged(Data(base64Encoded: VideoDateTests.dated)!)
    let probe = RangedAsset(name: "clip.mp4", size: Int64(r.data.count), read: r.read)
    defer { probe.cancel() }
    let i = await Media.info(asset: probe.asset, location: { nil })
    #expect(i.captureTs == 1_623_751_200_000)
    #expect(i.width == 16 && i.height == 16)
    #expect(await Media.jpeg(asset: probe.asset, maxPx: 640, quality: 0.8) != nil)
  }

  /** moov at the end, as Android writes it: only box headers on the way and moov itself are read. */
  @Test func videoLocationThroughRanges() async throws {
    var d = Data(base64Encoded: VideoDateTests.dated)!
    let text = Data("+47.3769+008.5417/".utf8)
    func be32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).bigEndian) { Data($0) } }
    var xyz = be32(12 + text.count) + Data([0xA9]) + Data("xyz".utf8)
    xyz += Data([UInt8(text.count >> 8), UInt8(text.count & 0xFF), 0x15, 0xC7]) + text
    for name in ["moov", "udta"] {
      let at = d.range(of: Data(name.utf8), options: .backwards)!.lowerBound - 4
      let size = d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      d.replaceSubrange(at..<at + 4, with: be32(size + xyz.count))
    }
    d += xyz
    // a large mdat in front, never read
    let pad = 40 << 20
    let ftypEnd = 32
    var big = d.prefix(ftypEnd)
    big += be32(pad) + Data("free".utf8) + Data(count: pad - 8)
    big += d.dropFirst(ftypEnd)
    let r = Ranged(big)
    let p = await Media.remoteVideoLocation(size: Int64(big.count), read: r.read)
    #expect(abs((p?.lat ?? 0) - 47.3769) < 1e-6 && abs((p?.lon ?? 0) - 8.5417) < 1e-6)
    #expect(r.bytes < 8192, "read \(r.bytes) bytes")
  }

  @Test func probeStopsAtItsBudget() async throws {
    let r = Ranged(Data(base64Encoded: VideoDateTests.dated)! + Data(count: 4 << 20))
    let probe = RangedAsset(name: "x.mp4", size: Int64(r.data.count), budget: 64 << 10, read: r.read)
    defer { probe.cancel() }
    _ = await Media.info(asset: probe.asset, location: { nil })
    #expect(probe.fetched <= 64 << 10)
    #expect(r.bytes <= 64 << 10)
  }
}

/** A WebDAV server in the test: answers by the request (no network). */
final class StubDAV: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, [String: String], Data))?
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "dav.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let (code, headers, body) = Self.handler!(request)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Suite(.serialized) struct WebDAVClientTests {
  let file = Data((0..<10_000).map { UInt8($0 % 251) })
  let folder = URL(string: "https://dav.test/photos/")!
  var entry: WebDAVEntry { WebDAVEntry(name: "a.jpg", url: folder.appendingPathComponent("a.jpg"), size: Int64(file.count), etag: "\"v1\"") }

  func client(ranges: Bool, total: Int? = nil) -> WebDAVClient {
    let f = file
    StubDAV.handler = { r in
      if r.httpMethod == "PROPFIND" { return (405, [:], Data()) }
      guard ranges, let h = r.value(forHTTPHeaderField: "Range"), h.hasPrefix("bytes=") else { return (200, [:], f) }
      let p = h.dropFirst(6).split(separator: "-").map { Int($0)! }
      return (206, ["Content-Range": "bytes \(p[0])-\(p[1])/\(total ?? f.count)"], f.subdata(in: p[0]..<p[1] + 1))
    }
    return WebDAVClient(folder: folder, user: "u", password: "p", protocols: [StubDAV.self])
  }

  @Test func readsParts() async throws {
    let c = client(ranges: true)
    #expect(try await c.sendsRanges(entry))
    #expect(try await c.read(entry, offset: 100, len: 50) == file.subdata(in: 100..<150))
  }

  @Test func aServerWithoutRangesIsFoundOut() async throws {
    let c = client(ranges: false)
    #expect(try await !c.sendsRanges(entry))
    await #expect(throws: WebDAVError.noRanges) { try await c.read(entry, offset: 100, len: 50) }
    // the whole file in one piece is fine
    #expect(try await c.read(entry, offset: 0, len: file.count) == file)
  }

  @Test func anotherVersionOfTheFileIsRefused() async throws {
    let c = client(ranges: true, total: 12_345)
    await #expect(throws: WebDAVError.changed) { try await c.read(entry, offset: 0, len: 10) }
  }

  @Test func notAWebDAVFolder() async throws {
    await #expect(throws: WebDAVError.notWebDAV) { try await client(ranges: true).list() }
  }

  /** A file the locked folder has is read like a new one (the server can't tell it apart) and then dropped: not
   *  uploaded, recorded as imported. */
  @Test func aLockedFolderFileIsReadAndDropped() async throws {
    let f = file
    let reads = Counter()
    StubDAV.handler = { r in
      guard let h = r.value(forHTTPHeaderField: "Range"), h.hasPrefix("bytes=") else { return (200, [:], f) }
      reads.add(1)
      let p = h.dropFirst(6).split(separator: "-").map { Int($0)! }
      return (206, ["Content-Range": "bytes \(p[0])-\(p[1])/\(f.count)"], f.subdata(in: p[0]..<p[1] + 1))
    }
    let c = WebDAVClient(folder: folder, user: "u", password: "p", protocols: [StubDAV.self])
    let print = Crypto.fingerprint(name: entry.name, size: entry.size)
    let book = ImportBook(file: nil)
    let p = WebDAVImport.plan(WebDAVListing(files: [entry], folders: 0), book: book, known: [], locked: [print])
    #expect(p.todo == [entry] && p.readOnly == [entry.name] && p.inLibrary == 0)
    let events = Counter()
    // the Cipherfilm server isn't reachable: an upload would end the pass with an error
    try await WebDAVImport.run(p.todo, client: c, api: API(base: URL(string: "https://127.0.0.1:9")!), wrap: .sealed(pk: Data(repeating: 1, count: 32)),
                               book: book, temp: FileManager.default.temporaryDirectory, readOnly: p.readOnly, live: {}) { ev in
      if case .alreadyThere = ev { events.add(1) }
    }
    #expect(reads.value >= 1 && events.value == 1 && book.isDone(entry))
  }

  /** No answer is taken in beyond what was asked for: a part longer than requested, a whole file longer than listed,
   *  a listing that announces more than the cap. */
  @Test func answersLongerThanAskedForAreRefused() async throws {
    let big = Data(count: 50_000)
    StubDAV.handler = { r in
      if r.httpMethod == "PROPFIND" { return (207, ["Content-Length": "\(WebDAVClient.listingCap + 1)"], Data()) }
      if let h = r.value(forHTTPHeaderField: "Range") { return (206, ["Content-Range": "\(h.replacingOccurrences(of: "=", with: " "))/10000"], big) }
      return (200, [:], big)
    }
    let c = WebDAVClient(folder: folder, user: "u", password: "p", protocols: [StubDAV.self])
    await #expect(throws: WebDAVError.changed) { try await c.read(entry, offset: 0, len: 50) }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-dl-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let dest = dir.appendingPathComponent("a.jpg")
    await #expect(throws: WebDAVError.changed) { try await c.download(entry, to: dest) }
    #expect(!FileManager.default.fileExists(atPath: dest.path))
    #expect(c.received.value <= 2 << 20)
    await #expect(throws: WebDAVError.malformed) { try await c.list() }
  }

  /** A server without ranges answers a part with the whole file: found out without taking the file in, and the
   *  temporary copy then comes in one piece of exactly the listed size. */
  @Test func aWholeFileIsNotReadForAPart() async throws {
    let c = client(ranges: false)
    await #expect(throws: WebDAVError.noRanges) { try await c.read(entry, offset: 100, len: 50) }
    #expect(c.knownToSendRanges == false)
    #expect(c.received.value == 0)
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-dl-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let dest = dir.appendingPathComponent("a.jpg")
    try await c.download(entry, to: dest)
    #expect(try Data(contentsOf: dest) == file)
  }
}

/** The temporary copies' disk budget: files take turns only when together they'd pass the limit, one always may,
 *  and the disk keeps its margin. */
@Suite struct DiskBudgetTests {
  final class Free: @unchecked Sendable { let lock = NSLock(); var v: Int64?; init(_ v: Int64?) { self.v = v }; func get() -> Int64? { lock.withLock { v } } }

  @Test func smallFilesShareTheBudget() async throws {
    let b = DiskBudget(limit: 100, margin: 0, free: { nil })
    try await b.acquire(40); try await b.acquire(40)
    #expect(b.inUse == 80)
  }

  @Test func oneFileAlwaysMayWhateverItsSize() async throws {
    let b = DiskBudget(limit: 100, margin: 0, free: { nil })
    try await b.acquire(10_000)
    #expect(b.inUse == 10_000)
  }

  @Test func aSecondLargeFileWaitsForTheFirst() async throws {
    let b = DiskBudget(limit: 100, margin: 0, free: { nil })
    try await b.acquire(80)
    let second = Task { try await b.acquire(80) }
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(b.inUse == 80) // still waiting
    b.release(80)
    try await second.value
    #expect(b.inUse == 80)
  }

  @Test func theDiskKeepsItsMargin() async throws {
    let free = Free(1_000)
    let b = DiskBudget(limit: 10_000, margin: 500, free: { free.get() })
    await #expect(throws: WebDAVError.diskFull) { try await b.acquire(600) }
    #expect(b.inUse == 0)
    try await b.acquire(400)
    // the space reserved for the first copy counts as gone
    await #expect(throws: WebDAVError.diskFull) { try await b.acquire(200) }
    #expect(WebDAVError.diskFull.transient) // the pass ends and is tried again later; no file counts as failed
  }

  @Test func aStopEndsTheWait() async throws {
    let b = DiskBudget(limit: 100, margin: 0, free: { nil })
    try await b.acquire(80)
    await #expect(throws: Stopped.self) { try await b.acquire(80, live: { throw Stopped() }) }
  }
}
