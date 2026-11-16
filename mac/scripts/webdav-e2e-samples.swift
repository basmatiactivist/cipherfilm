// Writes N drawn JPEGs with a capture time, camera and place for webdav-e2e.sh: no real pictures needed.
//   swift webdav-e2e-samples.swift OUT_FOLDER N
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let n = Int(CommandLine.arguments[2]) ?? 300
let props: [CFString: Any] = [
  kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "GenCam", kCGImagePropertyTIFFModel: "G1"],
  kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2024:07:14 18:03:22", kCGImagePropertyExifOffsetTimeOriginal: "+02:00"],
  kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 46.948, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 7.447, kCGImagePropertyGPSLongitudeRef: "E"],
  kCGImageDestinationLossyCompressionQuality: 0.9,
]
for i in 1...n {
  let w = 2400, h = 1600
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  var seed = UInt64(i) &* 6364136223846793005
  func rnd() -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat(seed >> 40) / CGFloat(1 << 24) }
  for _ in 0..<400 {
    ctx.setFillColor(red: rnd(), green: rnd(), blue: rnd(), alpha: 1)
    ctx.fill(CGRect(x: rnd() * CGFloat(w), y: rnd() * CGFloat(h), width: rnd() * 300, height: rnd() * 300))
  }
  let name = String(format: "gen-%04d.jpg", i)
  let d = CGImageDestinationCreateWithURL(out.appendingPathComponent(name) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, ctx.makeImage()!, props as CFDictionary)
  precondition(CGImageDestinationFinalize(d), name)
}

// one photo over WebDAVImport.memoryLimit (48 MB): it goes through a temporary copy within the disk budget
if CommandLine.arguments.count > 3 && CommandLine.arguments[3] == "big" {
  // a gradient with light grain: large as a PNG, but its preview compresses like a photo's (pure noise would not fit
  // the server's 3 MB for a preview)
  let w = 7000, h = 7000
  var px = [UInt8](repeating: 0, count: w * h * 4)
  var seed: UInt64 = 42
  for y in 0..<h { for x in 0..<w {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    let n = Int(seed >> 59) // 0...31
    let i = (y * w + x) * 4
    px[i] = UInt8(min(255, x * 200 / w + n)); px[i + 1] = UInt8(min(255, y * 200 / h + n)); px[i + 2] = UInt8(min(255, 120 + n))
  } }
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  let d = CGImageDestinationCreateWithURL(out.appendingPathComponent("huge.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, ctx.makeImage()!, [:] as CFDictionary)
  precondition(CGImageDestinationFinalize(d), "huge.png")
}
