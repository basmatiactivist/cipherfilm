// Encrypts a file on this Mac and uploads it part by part, exactly like the web and Android clients: the same segment
// format, keys and metadata, so every client and cipherfilm-decrypt read it. Only ciphertext leaves the Mac.
import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum Media {
  public static let thumbPx = 640
  public static let previewPx = 2048
  public static let maxFile: Int64 = 8 << 30

  public static func mime(of url: URL) -> String {
    UTType(filenameExtension: url.pathExtension.lowercased())?.preferredMIMEType ?? "application/octet-stream"
  }

  public static func kind(name: String, mime: String) -> Kind {
    let n = name.lowercased()
    if mime.hasPrefix("video/") || n.range(of: #"\.(mp4|mov|m4v|3gp|webm)$"#, options: .regularExpression) != nil { return .video }
    if mime.hasPrefix("image/") || n.range(of: #"\.(jpe?g|png|webp|heic|heif|gif|dng)$"#, options: .regularExpression) != nil { return .image }
    return .other
  }

  /** Whether a file in a watched folder is a photo or video worth backing up. */
  public static func isMedia(_ url: URL) -> Bool {
    guard let t = UTType(filenameExtension: url.pathExtension.lowercased()) else { return false }
    return t.conforms(to: .image) || t.conforms(to: .movie) || t.conforms(to: .audiovisualContent)
  }

  /** An upright JPEG no larger than maxPx on its long side; a frame at 1 s for videos. */
  public static func jpeg(_ url: URL, video: Bool, maxPx: Int, quality: Double) async -> (data: Data, width: Int, height: Int)? {
    if video { return await jpeg(asset: AVURLAsset(url: url), maxPx: maxPx, quality: quality) }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return jpeg(source: src, maxPx: maxPx, quality: quality)
  }

  /** The same from a picture's bytes in memory (a file streamed from a WebDAV folder). */
  public static func jpeg(data: Data, maxPx: Int, quality: Double) -> (data: Data, width: Int, height: Int)? {
    guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
    return jpeg(source: src, maxPx: maxPx, quality: quality)
  }

  static func jpeg(source src: CGImageSource, maxPx: Int, quality: Double) -> (data: Data, width: Int, height: Int)? {
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPx, kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary), let d = encodeJPEG(img, quality: quality) else { return nil }
    return (d, img.width, img.height)
  }

  /** A video's frame at 1 s (or its first), from a file or from ranged reads of a remote one (RangedAsset). */
  static func jpeg(asset: AVAsset, maxPx: Int, quality: Double) async -> (data: Data, width: Int, height: Int)? {
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: maxPx, height: maxPx)
    gen.requestedTimeToleranceBefore = .positiveInfinity
    gen.requestedTimeToleranceAfter = .positiveInfinity
    var img = try? await gen.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
    if img == nil { img = try? await gen.image(at: .zero).image }
    guard let img, let d = encodeJPEG(img, quality: quality) else { return nil }
    return (d, img.width, img.height)
  }

  /** Decodes a picture that comes from elsewhere (the server's thumbnails and previews) at most maxPx on its long side:
   *  one larger than any this app makes is scaled down while it is decoded, so it can't take unbounded memory. */
  public static func decodeBounded(_ d: Data, maxPx: Int = 4096) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(d as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0 else { return nil }
    if max(w, h) <= maxPx { return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) }
    return CGImageSourceCreateThumbnailAtIndex(src, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: false,
      kCGImageSourceThumbnailMaxPixelSize: maxPx, kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary)
  }

  public static func encodeJPEG(_ img: CGImage, quality: Double) -> Data? {
    let out = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dst) ? out as Data : nil
  }

  public struct Info: Sendable {
    public var captureTs: Double?
    public var width: Int?, height: Int?
    public var duration: Double?
    public var make: String?, model: String?
    public var lat: Double?, lon: Double?
  }

  /** Capture time, size, camera and place, from EXIF or the video's own metadata. */
  public static func info(_ url: URL, video: Bool) async -> Info {
    if video { return await info(asset: AVURLAsset(url: url), location: { fileVideoLocation(url) }) }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return Info() }
    return info(source: src)
  }

  /** The same for a picture's bytes in memory. */
  public static func info(data: Data) -> Info {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return Info() }
    return info(source: src)
  }

  /** A video's: location falls back to reading its moov box when AVFoundation reports none (videoLocation). */
  static func info(asset a: AVAsset, location: @Sendable () async -> (lat: Double, lon: Double)?) async -> Info {
    var out = Info()
    if let d = try? await a.load(.duration), d.isNumeric { out.duration = d.seconds }
    if let t = try? await a.loadTracks(withMediaType: .video).first, let (sz, tr) = try? await t.load(.naturalSize, .preferredTransform) {
      let r = sz.applying(tr)
      out.width = Int(abs(r.width).rounded()); out.height = Int(abs(r.height).rounded())
    }
    if let d = try? await a.load(.creationDate), let date = try? await d.load(.dateValue) { out.captureTs = date.timeIntervalSince1970 * 1000 }
    if let p = await metadataLocation(a) { (out.lat, out.lon) = (p.lat, p.lon) } else if let p = await location() { (out.lat, out.lon) = (p.lat, p.lon) }
    return out
  }

  static func info(source src: CGImageSource) -> Info {
    var out = Info()
    guard let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return out }
    if let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int {
      let o = p[kCGImagePropertyOrientation] as? Int ?? 1
      (out.width, out.height) = (5...8).contains(o) ? (h, w) : (w, h)
    }
    let exif = p[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    let tiff = p[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    if let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String ?? tiff[kCGImagePropertyTIFFDateTime] as? String {
      out.captureTs = exifDate(s, offset: exif[kCGImagePropertyExifOffsetTimeOriginal] as? String)
    }
    if let m = tiff[kCGImagePropertyTIFFMake] as? String, !m.trimmingCharacters(in: .whitespaces).isEmpty { out.make = m.trimmingCharacters(in: .whitespaces) }
    if let m = tiff[kCGImagePropertyTIFFModel] as? String, !m.trimmingCharacters(in: .whitespaces).isEmpty { out.model = m.trimmingCharacters(in: .whitespaces) }
    if let g = p[kCGImagePropertyGPSDictionary] as? [CFString: Any], let lat = g[kCGImagePropertyGPSLatitude] as? Double, let lon = g[kCGImagePropertyGPSLongitude] as? Double {
      out.lat = (g[kCGImagePropertyGPSLatitudeRef] as? String) == "S" ? -lat : lat
      out.lon = (g[kCGImagePropertyGPSLongitudeRef] as? String) == "W" ? -lon : lon
    }
    return out
  }

  /** Where a video was recorded. iPhones write it as QuickTime metadata (moov/meta keys), Android and most cameras as
   *  user data (moov/udta/©xyz). AVFoundation finds both, but in an MP4 (Android's) it hands the ©xyz atom over as
   *  raw bytes, its 16-bit text length and language still in front: those are read here. The iPhone's key in a meta
   *  box inside udta (as ffmpeg writes it) AVFoundation doesn't report: for that, and anything else it missed, the
   *  file's moov box is read directly, like the web app and the upload tool do (web/src/places/videoLocation.ts). */
  static func videoLocation(_ a: AVURLAsset) async -> (lat: Double, lon: Double)? {
    if let p = await metadataLocation(a) { return p }
    return a.url.isFileURL ? fileVideoLocation(a.url) : nil
  }

  static func metadataLocation(_ a: AVAsset) async -> (lat: Double, lon: Double)? {
    guard let items = try? await a.load(.metadata) else { return nil }
    let ids: Set<AVMetadataIdentifier> = [
      .quickTimeMetadataLocationISO6709, .quickTimeUserDataLocationISO6709, .commonIdentifierLocation,
      AVMetadataIdentifier(rawValue: "uiso/%A9xyz"), // the ©xyz atom of an MP4
    ]
    for item in items where item.identifier.map(ids.contains) == true || item.commonKey == .commonKeyLocation {
      if let s = try? await item.load(.stringValue), let p = iso6709(s) { return p }
      if let d = try? await item.load(.dataValue), let p = xyzAtom(d) { return p }
    }
    return nil
  }

  // ---- the video's boxes, read directly: only the box headers on the way to moov and moov itself ----

  private static let maxMoov = 32 << 20 // a moov box that large is not a phone's video: not read
  private static let maxBoxes = 10_000
  static let locationKey = "com.apple.quicktime.location.ISO6709"

  struct Box { let type: String; let start: Int; let end: Int } // start: first byte after the header

  private static func u32(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3]) }
  /** A box type, each byte as one character (Latin-1), so 0xA9 is "©" as in "©xyz". */
  private static func fourCC(_ b: [UInt8], _ o: Int) -> String { String(b[o..<o + 4].map { Character(UnicodeScalar($0)) }) }

  /** The boxes in b[from, to). */
  static func children(_ b: [UInt8], _ from: Int, _ to: Int) -> [Box] {
    var out: [Box] = [], o = from
    let to = min(to, b.count)
    while o + 8 <= to && out.count < maxBoxes {
      var size = u32(b, o), head = 8
      if size == 1 {
        guard o + 16 <= to else { break }
        let hi = u32(b, o + 8), lo = u32(b, o + 12)
        guard hi == 0 else { break } // larger than any moov read here
        size = lo; head = 16
      } else if size == 0 { size = to - o }
      guard size >= head, o + size <= to else { break }
      out.append(Box(type: fourCC(b, o + 4), start: o + head, end: o + size))
      o += size
    }
    return out
  }

  /** The location in a meta box (keys + ilst), QuickTime style (no version and flags, starts with hdlr) or ISO style
   *  (a full box: version and flags first, as ffmpeg writes it into udta). */
  static func inMeta(_ b: [UInt8], _ box: Box) -> (lat: Double, lon: Double)? {
    guard box.end - box.start >= 8 else { return nil }
    let start = fourCC(b, box.start + 4) == "hdlr" ? box.start : box.start + 4
    let parts = children(b, start, box.end)
    var keys: [String] = []
    if let k = parts.first(where: { $0.type == "keys" }), k.end - k.start >= 8 {
      let count = u32(b, k.start + 4)
      var o = k.start + 8, i = 0
      while i < count && o + 8 <= k.end {
        let size = u32(b, o)
        guard size >= 8, o + size <= k.end else { break }
        keys.append(String(decoding: b[o + 8..<o + size], as: UTF8.self)) // after the size and the namespace ("mdta")
        o += size; i += 1
      }
    }
    guard let ilst = parts.first(where: { $0.type == "ilst" }) else { return nil }
    for entry in children(b, ilst.start, ilst.end) {
      // the entry's type is its 1-based number in keys, as 4 bytes
      let index = entry.type.unicodeScalars.reduce(0) { $0 << 8 | Int($1.value) }
      guard index >= 1, index <= keys.count, keys[index - 1] == locationKey else { continue }
      for d in children(b, entry.start, entry.end) where d.type == "data" && d.end - d.start > 8 {
        if let p = iso6709(String(decoding: b[d.start + 8..<d.end], as: UTF8.self)) { return p }
      }
    }
    return nil
  }

  /** The location inside a moov box's bytes: udta/©xyz, or a meta box in moov (iPhone) or in udta (ffmpeg and others). */
  static func locationInMoov(_ moov: [UInt8]) -> (lat: Double, lon: Double)? {
    for box in children(moov, 0, moov.count) {
      if box.type == "udta" {
        for c in children(moov, box.start, box.end) {
          if c.type == "\u{a9}xyz", c.end - c.start >= 4, let p = xyzAtom(Data(moov[c.start..<c.end])) { return p }
          if c.type == "meta", let p = inMeta(moov, c) { return p }
        }
      }
      if box.type == "meta", let p = inMeta(moov, box) { return p }
    }
    return nil
  }

  /** The location of an MP4 or QuickTime file, from its moov box (at the start or the end); none when it has none. */
  static func fileVideoLocation(_ url: URL) -> (lat: Double, lon: Double)? {
    guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? h.close() }
    guard let size = try? h.seekToEnd() else { return nil }
    return moovLocation(size: size) { o, n in
      guard (try? h.seek(toOffset: o)) != nil else { return nil }
      return try? h.read(upToCount: n)
    }
  }

  /** The same through ranged reads of a file elsewhere (a WebDAV folder): only the box headers on the way to moov and
   *  moov itself are fetched, wherever moov is. */
  static func remoteVideoLocation(size: Int64, read: @Sendable (Int64, Int) async throws -> Data) async -> (lat: Double, lon: Double)? {
    guard size > 0 else { return nil }
    var o: UInt64 = 0
    for _ in 0..<maxBoxes {
      guard let step = boxStep(at: o, size: UInt64(size), header: try? await read(Int64(o), Int(min(16, UInt64(size) - min(o, UInt64(size)))))) else { return nil }
      switch step {
      case .next(let n): o = n
      case .moov(let at, let len):
        guard let m = try? await read(Int64(at), len), m.count == len else { return nil }
        return locationInMoov([UInt8](m))
      }
    }
    return nil
  }

  static func moovLocation(size: UInt64, read: (UInt64, Int) -> Data?) -> (lat: Double, lon: Double)? {
    var o: UInt64 = 0
    for _ in 0..<maxBoxes {
      guard let step = boxStep(at: o, size: size, header: o < size ? read(o, Int(min(16, size - o))) : nil) else { return nil }
      switch step {
      case .next(let n): o = n
      case .moov(let at, let len):
        guard let m = read(at, len), m.count == len else { return nil }
        return locationInMoov([UInt8](m))
      }
    }
    return nil
  }

  enum BoxStep { case next(UInt64), moov(at: UInt64, len: Int) }

  /** The top-level box whose header (up to 16 bytes) starts at o: where the next one starts, or where moov's body is. */
  static func boxStep(at o: UInt64, size: UInt64, header hd: Data?) -> BoxStep? {
    // compared by what is left (size - o), never o + len: a crafted 64-bit box size would overflow the sum and trap
    guard o <= size, size - o >= 8, let hd else { return nil }
    let b = [UInt8](hd)
    guard b.count >= 8 else { return nil }
    var len = UInt64(u32(b, 0)), head: UInt64 = 8
    if len == 1 {
      guard b.count >= 16 else { return nil }
      len = UInt64(u32(b, 8)) << 32 | UInt64(u32(b, 12)); head = 16
    } else if len == 0 { len = size - o }
    guard len >= head, len <= size - o else { return nil }
    if fourCC(b, 4) == "moov" {
      guard len - head <= UInt64(maxMoov) else { return nil }
      return .moov(at: o + head, len: Int(len - head))
    }
    return .next(o + len)
  }

  /** A ©xyz atom's payload: text length, language, then the ISO 6709 text (at most what the atom holds). */
  static func xyzAtom(_ d: Data) -> (lat: Double, lon: Double)? {
    let b = [UInt8](d.prefix(4096))
    guard b.count >= 4 else { return nil }
    let n = Int(b[0]) << 8 | Int(b[1])
    return String(bytes: b[4..<min(4 + n, b.count)], encoding: .utf8).flatMap(iso6709)
  }

  /** The decimal-degrees form of ISO 6709 only, as phones write it: "+47.3769+008.5417+408.000/". Sign and two digits
   *  of latitude, sign and three of longitude, each with optional decimals; then nothing, "/", an altitude or "CRS…".
   *  The degrees-minutes forms are refused rather than misread as degrees, and so is 0,0, like a photo's. */
  static func iso6709(_ s: String) -> (lat: Double, lon: Double)? {
    var rest = Substring(s.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\0"))))
    func number(_ digits: Int) -> Double? {
      guard let sign = rest.first, sign == "+" || sign == "-" else { return nil }
      var i = rest.index(after: rest.startIndex)
      for _ in 0..<digits {
        guard i < rest.endIndex, rest[i].isASCII, rest[i].isNumber else { return nil }
        i = rest.index(after: i)
      }
      if i < rest.endIndex, rest[i] == "." {
        var j = rest.index(after: i), n = 0
        while j < rest.endIndex, rest[j].isASCII, rest[j].isNumber { j = rest.index(after: j); n += 1 }
        guard n > 0, n <= 15 else { return nil } // a point needs digits after it, and no more than any device writes
        i = j
      }
      let v = Double(rest[..<i])
      rest = rest[i...]
      return v
    }
    guard let lat = number(2), let lon = number(3) else { return nil }
    if let c = rest.first, c != "/", c != "+", c != "-", !rest.hasPrefix("CRS") { return nil }
    guard lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon), !(lat == 0 && lon == 0) else { return nil }
    return (lat, lon)
  }

  /** "2024:07:14 18:03:22" with an optional "+02:00"; without one it is local time, like the other clients. */
  static func exifDate(_ s: String, offset: String?) -> Double? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy:MM:dd HH:mm:ss"
    if let o = offset, let tz = TimeZone(iso8601Offset: o) { f.timeZone = tz } else { f.timeZone = .current }
    return f.date(from: String(s.prefix(19))).map { $0.timeIntervalSince1970 * 1000 }
  }
}

extension TimeZone {
  init?(iso8601Offset s: String) {
    let m = s.trimmingCharacters(in: .whitespaces)
    guard m.count == 6, let sign = m.first, sign == "+" || sign == "-", let h = Int(m.dropFirst().prefix(2)), let mi = Int(m.suffix(2)) else { return nil }
    self.init(secondsFromGMT: (sign == "-" ? -1 : 1) * (h * 3600 + mi * 60))
  }
}

public struct Stopped: Error, LocalizedError {
  public init() {}
  public var errorDescription: String? { "Stopped: you signed out or locked the app." }
}

public enum Uploader {
  /** How the new item key is locked: under the master key, or sealed to the account's public key (watched folders). */
  public enum Wrap: Sendable {
    case master(Data)
    case sealed(pk: Data)
    func apply(_ key: Data, _ id: String) throws -> Data {
      switch self {
      case .master(let m): return Crypto.wrapItemKey(key, master: m, itemId: id)
      case .sealed(let pk): return try Crypto.sealItemKey(key, pk: pk, itemId: id)
      }
    }
  }

  /** What is uploaded: a file on this Mac, or one streamed from elsewhere (a WebDAV folder, WebDAVImport.swift). */
  public struct Source: Sendable {
    public var name: String
    public var mime: String
    public var size: Int64
    /** the file's modification time: the capture time when its own metadata has none */
    public var modified: Date
    /** the bytes [offset, offset + len), asked for in order, one segment at a time; fewer bytes means it changed */
    public var read: @Sendable (_ offset: Int64, _ len: Int) async throws -> Data
    /** thumbnail and preview (made the same way for every source); nil when macOS can't decode it */
    public var pictures: @Sendable () async -> Pictures?
    public var info: @Sendable () async -> Media.Info

    public init(name: String, mime: String, size: Int64, modified: Date, read: @escaping @Sendable (Int64, Int) async throws -> Data,
                pictures: @escaping @Sendable () async -> Pictures?, info: @escaping @Sendable () async -> Media.Info) {
      self.name = name; self.mime = mime; self.size = size; self.modified = modified
      self.read = read; self.pictures = pictures; self.info = info
    }
  }

  public struct Pictures: Sendable {
    public let thumb: Data, preview: Data
    public let width: Int, height: Int
    public init?(thumb: (data: Data, width: Int, height: Int)?, preview: (data: Data, width: Int, height: Int)?) {
      guard let thumb, let preview else { return nil }
      self.thumb = thumb.data; self.preview = preview.data; width = preview.width; height = preview.height
    }
  }

  /** Uploads one file; resolves with the new item's id once the server has it. `live` throws to stop between steps. */
  public static func upload(_ url: URL, api: API, wrap: Wrap, live: @escaping @Sendable () throws -> Void = {},
                            progress: @escaping @Sendable (Int64, Int64) -> Void = { _, _ in }) async throws -> String {
    // opened once, not following a link swapped in for the file, and its size and kind read from that open file: the
    // parts are read from the same descriptor, so they are the file that was checked
    let fd = open(url.resolvingSymlinksInPath().path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw APIError(status: -1, message: "This file can't be opened.") }
    let fh = SendableHandle(FileHandle(fileDescriptor: fd, closeOnDealloc: true))
    defer { try? fh.h.close() }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG else { throw APIError(status: -1, message: "Only files can be uploaded, not folders or devices.") }
    let size = Int64(st.st_size)
    let modified = Date(timeIntervalSince1970: Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1e9)
    let name = url.lastPathComponent
    let mime = Media.mime(of: url)
    let video = Media.kind(name: name, mime: mime) == .video
    let src = Source(name: name, mime: mime, size: size, modified: modified, read: { o, n in
      try fh.h.seek(toOffset: UInt64(o))
      return n > 0 ? (try fh.h.read(upToCount: n) ?? Data()) : Data()
    }, pictures: {
      async let t = Media.jpeg(url, video: video, maxPx: Media.thumbPx, quality: 0.82)
      async let p = Media.jpeg(url, video: video, maxPx: Media.previewPx, quality: 0.85)
      return Pictures(thumb: await t, preview: await p)
    }, info: { await Media.info(url, video: video) })
    return try await upload(src, api: api, wrap: wrap, live: live, progress: progress)
  }

  /** Uploads from any source: encrypted segment by segment as it is read, at most `inFlight` segments on the way at
   *  once, so a file of any size takes a few segments of memory. */
  public static func upload(_ src: Source, api: API, wrap: Wrap, inFlight maxInFlight: Int = 2, live: @escaping @Sendable () throws -> Void = {},
                            progress: @escaping @Sendable (Int64, Int64) -> Void = { _, _ in }) async throws -> String {
    let size = src.size
    guard size >= 0 else { throw APIError(status: -1, message: "This file's size is unknown, so it can't be uploaded safely.") }
    guard size <= Media.maxFile else { throw APIError(status: -1, message: "Files over 8 GB can't be uploaded.") }
    let kind = Media.kind(name: src.name, mime: src.mime)
    let count = Segments.count(size)
    try live()
    struct Created: Decodable { let id: String }
    let id = try JSONDecoder().decode(Created.self, from: try await api.json("POST", "/api/items", body: ["kind": kind.rawValue, "size": size, "segment_count": count] as [String: Any])).id
    // the id goes into the key's binding and every request path: nothing is wrapped for one of another shape
    guard ServerId.valid(id) else { throw APIError(status: -1, message: "The server answered with an item id this app can't use.") }
    var itemKey = Crypto.newItemKey()
    defer { Sodium.memzero(&itemKey) }
    let key = itemKey
    do {
      let wrapped = B64.encode(try wrap.apply(key, id))
      // thumbnails while the parts upload; a file macOS can't decode still uploads, without a thumbnail
      let thumbs = Task<(Int, Int)?, Error> {
        guard kind != .other, let p = await src.pictures() else { return nil }
        try live()
        try await api.putBytes("/api/items/\(id)/thumb", Crypto.encryptThumb(p.thumb, itemKey: key, itemId: id))
        try await api.putBytes("/api/items/\(id)/preview", Crypto.encryptPreview(p.preview, itemKey: key, itemId: id))
        return (p.width, p.height)
      }
      let info = Task { await src.info() }

      progress(0, max(size, 1))
      let done = Counter()
      // the original's SHA-256 for the metadata (finding the same file again, docs/CRYPTO.md): from the parts as they
      // are read for encryption, never a second read of the file
      var hash = SHA256()
      do {
        try await withThrowingTaskGroup(of: Void.self) { g in
          var inFlight = 0
          for i in 0..<count {
            try live()
            let len = size == 0 ? 0 : Segments.plainLen(size, i)
            var plain = len > 0 ? try await src.read(Int64(i) * Int64(Segments.plain), len) : Data()
            guard plain.count == len else { throw APIError(status: -1, message: "The file changed while it was being read.") }
            hash.update(data: plain)
            let ct = try Segments.encrypt(itemKey: key, itemId: id, index: i, count: count, total: size, plain: plain)
            Sodium.memzero(&plain)
            if inFlight >= maxInFlight { try await g.next(); inFlight -= 1 }
            g.addTask {
              try await api.putBytes("/api/items/\(id)/segments/\(i)", ct)
              progress(min(done.add(Int64(len)), size), max(size, 1))
            }
            inFlight += 1
          }
          try await g.waitForAll()
        }
      } catch {
        thumbs.cancel(); info.cancel()
        throw error
      }
      let dims = (try? await thumbs.value) ?? nil
      let mi = await info.value
      let json = try metaJSON(name: src.name, mime: src.mime, size: size, modified: src.modified, info: mi, dims: dims, sha256: hex(hash.finalize()))
      try live()
      try await api.json("POST", "/api/items/\(id)/finalize", body: ["wrapped_item_key": wrapped, "meta_enc": B64.encode(Crypto.encryptMeta(json, itemKey: key, itemId: id))])
      return id
    } catch {
      // an unfinished upload is discarded right away instead of waiting for the server's cleanup
      Task { try? await api.json("DELETE", "/api/items/\(id)") }
      throw error
    }
  }
}

/** A file handle used by one upload at a time (its segments are read in order, never at once). */
final class SendableHandle: @unchecked Sendable {
  let h: FileHandle
  init(_ h: FileHandle) { self.h = h }
}

extension Uploader {
  /** The item's metadata as every client writes it (docs/CRYPTO.md). */
  static func metaJSON(name: String, mime: String, size: Int64, modified: Date, info mi: Media.Info, dims: (Int, Int)?, sha256: String?) throws -> Data {
    var meta: [String: Any] = [
      "name": name, "mime": mime, "size": size, "lastModified": (modified.timeIntervalSince1970 * 1000).rounded(),
      "capture_ts": (mi.captureTs ?? modified.timeIntervalSince1970 * 1000).rounded(),
    ]
    if let w = mi.width ?? dims?.0 { meta["width"] = w }
    if let h = mi.height ?? dims?.1 { meta["height"] = h }
    if let d = mi.duration { meta["duration"] = d }
    if let m = mi.make { meta["make"] = m }
    if let m = mi.model { meta["model"] = m }
    if let la = mi.lat, let lo = mi.lon { meta["gps"] = ["lat": la, "lon": lo] }
    if let h = sha256 { meta["sha256"] = h }
    return try JSONSerialization.data(withJSONObject: meta, options: [.withoutEscapingSlashes])
  }

  static func hex(_ d: SHA256.Digest) -> String { d.map { String(format: "%02x", $0) }.joined() }
}

public final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n: Int64 = 0
  public init() {}
  @discardableResult public func add(_ x: Int64) -> Int64 { lock.withLock { n += x; return n } }
  public var value: Int64 { lock.withLock { n } }
}
