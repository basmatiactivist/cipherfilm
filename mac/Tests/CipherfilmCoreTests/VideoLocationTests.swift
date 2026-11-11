// A video's place goes into its metadata like a photo's, so it shows on the map. Both ways phones store it are read:
// the iPhone's QuickTime metadata (moov/meta keys) and Android's user data atom (moov/udta/©xyz).
import AVFoundation
import CoreVideo
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct VideoLocationTests {
  private func temp(_ ext: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("cf-loc-\(UUID().uuidString).\(ext)")
  }

  /** A real one-frame movie written by AVFoundation with the location under the given identifier: QuickTime metadata
   *  is what an iPhone writes, QuickTime user data what many cameras write into a .mov. */
  private func writtenMovie(_ iso6709: String, as id: AVMetadataIdentifier, moovFirst: Bool = false) async throws -> URL {
    let url = temp("mov")
    let w = try AVAssetWriter(outputURL: url, fileType: .mov)
    w.shouldOptimizeForNetworkUse = moovFirst
    let loc = AVMutableMetadataItem()
    loc.identifier = id
    loc.dataType = kCMMetadataBaseDataType_UTF8 as String
    loc.value = iso6709 as NSString
    w.metadata = [loc]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 16, AVVideoHeightKey: 16])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
    w.add(input)
    #expect(w.startWriting())
    w.startSession(atSourceTime: .zero)
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(nil, 16, 16, kCVPixelFormatType_32BGRA, nil, &pb)
    while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
    #expect(adaptor.append(pb!, withPresentationTime: .zero))
    input.markAsFinished()
    w.endSession(atSourceTime: CMTime(value: 1, timescale: 30))
    await w.finishWriting()
    #expect(w.status == .completed)
    return url
  }

  /** The ffmpeg MP4 of VideoDateTests with a ©xyz atom added to its user data, as Android's MediaMuxer writes it. Its
   *  moov is the last box and udta the last box in moov, so the atom goes at the end and both sizes grow. */
  private func androidMovie(_ iso6709: String) throws -> URL {
    var d = Data(base64Encoded: VideoDateTests.dated)!
    let text = Data(iso6709.utf8)
    var xyz = Data()
    func be32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).bigEndian) { Data($0) } }
    xyz += be32(12 + text.count) + Data([0xA9]) + Data("xyz".utf8)
    xyz += Data([UInt8(text.count >> 8), UInt8(text.count & 0xFF), 0x15, 0xC7]) + text
    for name in ["moov", "udta"] {
      let at = d.range(of: Data(name.utf8), options: .backwards)!.lowerBound - 4
      let size = d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      #expect(at + size == d.count, "\(name) is not the last box")
      d.replaceSubrange(at..<at + 4, with: be32(size + xyz.count))
    }
    d += xyz
    let url = temp("mp4")
    try d.write(to: url)
    return url
  }

  @Test func iPhoneLocation() async throws {
    let url = try await writtenMovie("+47.3769+008.5417+408.000/", as: .quickTimeMetadataLocationISO6709)
    defer { try? FileManager.default.removeItem(at: url) }
    let d = try Data(contentsOf: url) // the keys + ilst form, not a ©xyz atom
    #expect(d.range(of: Data("keys".utf8)) != nil && d.range(of: Data("com.apple.quicktime.location.ISO6709".utf8)) != nil)
    #expect(d.range(of: Data([0xA9]) + Data("xyz".utf8)) == nil)
    let i = await Media.info(url, video: true)
    #expect(i.lat == 47.3769 && i.lon == 8.5417)
  }

  @Test func quickTimeUserDataLocation() async throws {
    let url = try await writtenMovie("+40.6892-074.0445/", as: .quickTimeUserDataLocationISO6709, moovFirst: true)
    defer { try? FileManager.default.removeItem(at: url) }
    let d = try Data(contentsOf: url)
    #expect(d.range(of: Data([0xA9]) + Data("xyz".utf8)) != nil)
    #expect(d.range(of: Data("moov".utf8))!.lowerBound < d.range(of: Data("mdat".utf8))!.lowerBound) // the header first, this time
    let i = await Media.info(url, video: true)
    #expect(i.lat == 40.6892 && i.lon == -74.0445)
  }

  @Test func androidLocation() async throws {
    let url = try androidMovie("-33.9249+018.4241/")
    defer { try? FileManager.default.removeItem(at: url) }
    let i = await Media.info(url, video: true)
    #expect(i.lat == -33.9249 && i.lon == 18.4241)
    #expect(i.captureTs == 1_623_751_200_000) // the rest of the header still reads
  }

  @Test func noLocationIsNone() async throws {
    let url = temp("mp4")
    try Data(base64Encoded: VideoDateTests.dated)!.write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let i = await Media.info(url, video: true)
    #expect(i.lat == nil && i.lon == nil)
  }

  @Test func nullIslandIsNone() async throws {
    let url = try androidMovie("+00.0000+000.0000/")
    defer { try? FileManager.default.removeItem(at: url) }
    #expect(await Media.info(url, video: true).lat == nil)
  }

  @Test func xyzAtomText() {
    func atom(_ n: Int, _ s: String) -> Data { Data([UInt8(n >> 8), UInt8(n & 0xFF), 0x15, 0xC7]) + Data(s.utf8) }
    #expect(Media.xyzAtom(atom(18, "+47.3769+008.5417/"))?.lat == 47.3769)
    #expect(Media.xyzAtom(atom(0xFFFF, "+47.3769+008.5417/"))?.lat == 47.3769) // a length past the end reads what is there
    #expect(Media.xyzAtom(atom(8, "+47.3769+008.5417/")) == nil) // cut by its length
    #expect(Media.xyzAtom(Data([0, 1, 0])) == nil)
    #expect(Media.xyzAtom(Data()) == nil)
  }

  @Test func parsesOnlyDecimalDegrees() {
    let good: [String: (Double, Double)] = [
      "+47.3769+008.5417+408.000/": (47.3769, 8.5417), "+47.3769+008.5417/": (47.3769, 8.5417),
      "-33.9249+018.4241/": (-33.9249, 18.4241), "+47.3769+008.5417": (47.3769, 8.5417), "+47+008/": (47, 8),
      "-90.0000-180.0000/": (-90, -180), "+12.5-045.25CRSWGS_84/": (12.5, -45.25), "+47.3769+008.5417/\0": (47.3769, 8.5417),
    ]
    for (s, want) in good {
      let p = Media.iso6709(s)
      #expect(p?.lat == want.0 && p?.lon == want.1, "\(s)")
    }
    for s in ["", "+", "+47.3769", "+47.3769+08.5417/", "+NaN+008.5417/", "+4.3769+008.5417/", "+47.3769+008.5417 /",
              "+47.3769e5+008.5417/", "+47.37690000000000000001+008.5417/", "-00.0+000.0/", "+90.0001+000.0001/",
              "+4722.61+00832.50/", "47.3769+008.5417/", "+47.+008.5417/", "+４７.0+008.0/"] {
      #expect(Media.iso6709(s) == nil, "\(s)")
    }
  }

  // ---- the boxes read directly (Media.locationInMoov), as web/src/places/videoLocation.ts and tools/upload do ----

  private static func be32(_ v: Int) -> [UInt8] { withUnsafeBytes(of: UInt32(v).bigEndian) { Array($0) } }
  private static func box(_ type: String, _ payload: [UInt8]) -> [UInt8] { be32(8 + payload.count) + Array(type.unicodeScalars.map { UInt8($0.value) }) + payload }
  private static func box(_ index: Int, _ payload: [UInt8]) -> [UInt8] { be32(8 + payload.count) + be32(index) + payload }
  /** keys + ilst with the location as the second key, after another one; fullBox: version and flags first (ISO style,
   *  as ffmpeg writes a meta box into udta), else QuickTime style (hdlr first). */
  static func metaBox(_ iso6709: String, fullBox: Bool) -> [UInt8] {
    let hdlr = box("hdlr", [UInt8](repeating: 0, count: 8) + Array("mdta".utf8) + [UInt8](repeating: 0, count: 13))
    let names = ["com.apple.quicktime.make", Media.locationKey]
    let keys = box("keys", [0, 0, 0, 0] + be32(names.count) + names.flatMap { be32(8 + $0.utf8.count) + Array("mdta".utf8) + Array($0.utf8) })
    let data = { (v: String) in box("data", be32(1) + be32(0) + Array(v.utf8)) }
    let ilst = box("ilst", box(1, data("Apple")) + box(2, data(iso6709)))
    return box("meta", (fullBox ? [0, 0, 0, 0] : []) + hdlr + keys + ilst)
  }
  static func xyzBox(_ iso6709: String) -> [UInt8] {
    let t = Array(iso6709.utf8)
    return be32(12 + t.count) + [0xA9] + Array("xyz".utf8) + [UInt8(t.count >> 8), UInt8(t.count & 0xFF), 0x15, 0xC7] + t
  }
  private static let mvhd = box("mvhd", [UInt8](repeating: 0, count: 100))

  @Test func boxesUdtaXyz() {
    let moov = Self.mvhd + Self.box("udta", Self.box("name", [0, 0]) + Self.xyzBox("-33.9249+018.4241/"))
    let p = Media.locationInMoov(moov)
    #expect(p?.lat == -33.9249 && p?.lon == 18.4241)
  }

  @Test func boxesMoovMetaKeys() {
    let moov = Self.mvhd + Self.metaBox("+47.3769+008.5417+408.000/", fullBox: false)
    let p = Media.locationInMoov(moov)
    #expect(p?.lat == 47.3769 && p?.lon == 8.5417)
  }

  @Test func boxesUdtaMetaKeys() {
    for full in [true, false] {
      let moov = Self.mvhd + Self.box("udta", Self.box("\u{a9}too", [0, 3, 0, 0] + Array("x".utf8)) + Self.metaBox("+40.6892-074.0445/", fullBox: full))
      let p = Media.locationInMoov(moov)
      #expect(p?.lat == 40.6892 && p?.lon == -74.0445, "full box: \(full)")
    }
  }

  @Test func boxesWithoutLocationOrDamaged() {
    #expect(Media.locationInMoov(Self.mvhd) == nil)
    #expect(Media.locationInMoov([]) == nil)
    // the location under a key that isn't the location's, and an ilst entry pointing past the keys
    var other = Self.metaBox("+47.3769+008.5417/", fullBox: true)
    let at = other.count - (8 + 8 + 8 + "+47.3769+008.5417/".utf8.count) // the second ilst entry's header
    other.replaceSubrange(at + 4..<at + 8, with: Self.be32(1))
    #expect(Media.locationInMoov(Self.mvhd + Self.box("udta", other)) == nil)
    other.replaceSubrange(at + 4..<at + 8, with: Self.be32(9))
    #expect(Media.locationInMoov(Self.mvhd + Self.box("udta", other)) == nil)
    // cut short anywhere: nothing read, nothing crashes
    let whole = Self.mvhd + Self.box("udta", Self.metaBox("+47.3769+008.5417/", fullBox: true))
    for n in stride(from: 0, to: whole.count, by: 7) { _ = Media.locationInMoov(Array(whole.prefix(n))) }
    #expect(Media.locationInMoov(Self.box("udta", Self.metaBox("+00.0000+000.0000/", fullBox: true))) == nil)
  }

  /** The ffmpeg MP4 of VideoDateTests with the iPhone's key in a meta box inside udta, as ffmpeg writes it with
   *  -movflags use_metadata_tags: read from the file as uploads read it. */
  @Test func ffmpegUdtaMetaFile() throws {
    var d = Data(base64Encoded: VideoDateTests.dated)!
    let meta = Data(Self.metaBox("+51.5007-000.1246/", fullBox: true))
    for name in ["moov", "udta"] {
      let at = d.range(of: Data(name.utf8), options: .backwards)!.lowerBound - 4
      let size = d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      #expect(at + size == d.count, "\(name) is not the last box")
      d.replaceSubrange(at..<at + 4, with: Self.be32(size + meta.count))
    }
    d += meta
    let url = temp("mp4")
    try d.write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let p = Media.fileVideoLocation(url)
    #expect(p?.lat == 51.5007 && p?.lon == -0.1246)
  }

  @Test func ffmpegUdtaMetaInfo() async throws {
    var d = Data(base64Encoded: VideoDateTests.dated)!
    let meta = Data(Self.metaBox("+51.5007-000.1246/", fullBox: true))
    for name in ["moov", "udta"] {
      let at = d.range(of: Data(name.utf8), options: .backwards)!.lowerBound - 4
      let size = d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      d.replaceSubrange(at..<at + 4, with: Self.be32(size + meta.count))
    }
    d += meta
    let url = temp("mp4")
    try d.write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let i = await Media.info(url, video: true)
    #expect(i.lat == 51.5007 && i.lon == -0.1246)
    #expect(i.captureTs == 1_623_751_200_000)
  }
}
