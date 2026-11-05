// How long one photo takes through the models (CF_MODELS set; run with -c release for real numbers).
import CoreGraphics
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct SpeedTests {
  @Test(.enabled(if: ProcessInfo.processInfo.environment["CF_MODELS"] != nil)) func analyzeSpeed() throws {
    let v = try Vision(dir: URL(fileURLWithPath: ProcessInfo.processInfo.environment["CF_MODELS"]!), faces: true, threads: 4)
    let w = 2048, h = 1536
    var px = [UInt8](repeating: 255, count: w * h * 4)
    for i in 0..<(w * h) { px[i * 4] = UInt8(i % 251); px[i * 4 + 1] = UInt8(i % 241); px[i * 4 + 2] = UInt8(i % 239) }
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let jpeg = Media.encodeJPEG(ctx.makeImage()!, quality: 0.85)!
    _ = try v.analyze(jpeg, faces: true)
    var t = Date()
    for _ in 0..<5 { _ = try v.analyze(jpeg, faces: true) }
    print("analyze: \(Int(Date().timeIntervalSince(t) / 5 * 1000)) ms per photo")
    let bmp = Pixels.decode(jpeg, maxPx: 1280)!
    t = Date(); for _ in 0..<5 { _ = bmp.smooth(341, 256) }; print("resize: \(Int(Date().timeIntervalSince(t) / 5 * 1000)) ms")
    t = Date(); for _ in 0..<5 { _ = Pixels.decode(jpeg, maxPx: 1280) }; print("decode: \(Int(Date().timeIntervalSince(t) / 5 * 1000)) ms")
    let dir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CF_MODELS"]!)
    if FileManager.default.fileExists(atPath: dir.appendingPathComponent(ClipModel.laion.vision.name).path) {
      let l = try Vision(dir: dir, faces: true, clip: .laion, threads: 4)
      _ = try l.analyze(jpeg, faces: true)
      t = Date(); for _ in 0..<5 { _ = try l.analyze(jpeg, faces: true) }; print("analyze with LAION: \(Int(Date().timeIntervalSince(t) / 5 * 1000)) ms per photo")
      t = Date(); for _ in 0..<5 { _ = bmp.bicubic(299, 224) }; print("bicubic resize: \(Int(Date().timeIntervalSince(t) / 5 * 1000)) ms")
    }
  }
}
