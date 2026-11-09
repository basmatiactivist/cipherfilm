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
}
