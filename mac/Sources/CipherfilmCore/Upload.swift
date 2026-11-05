// Encrypts a file on this Mac and uploads it part by part, exactly like the web and Android clients: the same segment
// format, keys and metadata, so every client and cipherfilm-decrypt read it. Only ciphertext leaves the Mac.
import AVFoundation
import CoreGraphics
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
    var img: CGImage?
    if video {
      let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: maxPx, height: maxPx)
      gen.requestedTimeToleranceBefore = .positiveInfinity
      gen.requestedTimeToleranceAfter = .positiveInfinity
      img = try? await gen.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
      if img == nil { img = try? await gen.image(at: .zero).image }
    } else if let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) {
      img = CGImageSourceCreateThumbnailAtIndex(src, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPx, kCGImageSourceShouldCacheImmediately: true,
      ] as CFDictionary)
    }
    guard let img, let d = encodeJPEG(img, quality: quality) else { return nil }
    return (d, img.width, img.height)
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
    var out = Info()
    if video {
      let a = AVURLAsset(url: url)
      if let d = try? await a.load(.duration), d.isNumeric { out.duration = d.seconds }
      if let t = try? await a.loadTracks(withMediaType: .video).first, let (sz, tr) = try? await t.load(.naturalSize, .preferredTransform) {
        let r = sz.applying(tr)
        out.width = Int(abs(r.width).rounded()); out.height = Int(abs(r.height).rounded())
      }
      if let d = try? await a.load(.creationDate), let date = try? await d.load(.dateValue) { out.captureTs = date.timeIntervalSince1970 * 1000 }
      return out
    }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return out }
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

  /** Uploads one file; resolves with the new item's id once the server has it. `live` throws to stop between steps. */
  public static func upload(_ url: URL, api: API, wrap: Wrap, live: @escaping @Sendable () throws -> Void = {},
                            progress: @escaping @Sendable (Int64, Int64) -> Void = { _, _ in }) async throws -> String {
    let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
    let size = (attrs[.size] as? NSNumber)?.int64Value ?? -1
    let modified = (attrs[.modificationDate] as? Date) ?? Date()
    guard size >= 0 else { throw APIError(status: -1, message: "This file's size is unknown, so it can't be uploaded safely.") }
    guard size <= Media.maxFile else { throw APIError(status: -1, message: "Files over 8 GB can't be uploaded.") }
    let name = url.lastPathComponent
    let mime = Media.mime(of: url)
    let kind = Media.kind(name: name, mime: mime)
    let count = Segments.count(size)
    try live()
    struct Created: Decodable { let id: String }
    let id = try JSONDecoder().decode(Created.self, from: try await api.json("POST", "/api/items", body: ["kind": kind.rawValue, "size": size, "segment_count": count] as [String: Any])).id
    var itemKey = Crypto.newItemKey()
    defer { Sodium.memzero(&itemKey) }
    let key = itemKey
    do {
      let wrapped = B64.encode(try wrap.apply(key, id))
      // thumbnails while the parts upload; a file macOS can't decode still uploads, without a thumbnail
      let thumbs = Task<(Int, Int)?, Error> {
        guard kind != .other else { return nil }
        async let t = Media.jpeg(url, video: kind == .video, maxPx: Media.thumbPx, quality: 0.82)
        async let p = Media.jpeg(url, video: kind == .video, maxPx: Media.previewPx, quality: 0.85)
        guard let t = await t, let p = await p else { return nil }
        try live()
        try await api.putBytes("/api/items/\(id)/thumb", Crypto.encryptThumb(t.data, itemKey: key, itemId: id))
        try await api.putBytes("/api/items/\(id)/preview", Crypto.encryptPreview(p.data, itemKey: key, itemId: id))
        return (p.width, p.height)
      }
      let info = Task { await Media.info(url, video: kind == .video) }

      let fh = try FileHandle(forReadingFrom: url)
      defer { try? fh.close() }
      progress(0, max(size, 1))
      let done = Counter()
      try await withThrowingTaskGroup(of: Void.self) { g in
        var inFlight = 0
        for i in 0..<count {
          try live()
          let len = size == 0 ? 0 : Segments.plainLen(size, i)
          try fh.seek(toOffset: UInt64(i) * UInt64(Segments.plain))
          var plain = len > 0 ? (try fh.read(upToCount: len) ?? Data()) : Data()
          guard plain.count == len else { throw APIError(status: -1, message: "The file changed while it was being read.") }
          let ct = try Segments.encrypt(itemKey: key, itemId: id, index: i, count: count, total: size, plain: plain)
          Sodium.memzero(&plain)
          if inFlight >= 2 { try await g.next(); inFlight -= 1 }
          g.addTask {
            try await api.putBytes("/api/items/\(id)/segments/\(i)", ct)
            progress(min(done.add(Int64(len)), size), max(size, 1))
          }
          inFlight += 1
        }
        try await g.waitForAll()
      }
      let dims = (try? await thumbs.value) ?? nil
      let mi = await info.value
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
      let json = try JSONSerialization.data(withJSONObject: meta, options: [.withoutEscapingSlashes])
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

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n: Int64 = 0
  func add(_ x: Int64) -> Int64 { lock.withLock { n += x; return n } }
}
