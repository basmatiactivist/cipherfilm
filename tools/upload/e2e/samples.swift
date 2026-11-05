// Writes the test photos and a short video for run.sh: drawn here, so no real pictures are needed.
//   swift samples.swift OUT_FOLDER
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let out = URL(fileURLWithPath: CommandLine.arguments[1])

func picture(_ w: Int, _ h: Int, _ seed: Int) -> CGImage {
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  for i in 0..<40 {
    let t = CGFloat((i * 37 + seed * 11) % 100) / 100
    ctx.setFillColor(red: t, green: 1 - t, blue: CGFloat(i % 7) / 7, alpha: 1)
    ctx.fill(CGRect(x: CGFloat(i) * CGFloat(w) / 40, y: 0, width: CGFloat(w) / 40 + 1, height: CGFloat(h) * (0.3 + 0.7 * t)))
  }
  ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: h - h / 8, width: w / 3, height: h / 8)) // marks the top left corner
  return ctx.makeImage()!
}

func write(_ img: CGImage, _ name: String, _ type: UTType, _ props: [CFString: Any]) {
  let d = CGImageDestinationCreateWithURL(out.appendingPathComponent(name) as CFURL, type.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(d, img, props as CFDictionary)
  precondition(CGImageDestinationFinalize(d), name)
}

let camera: [CFString: Any] = [
  kCGImagePropertyOrientation: 6,
  kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "TestCam", kCGImagePropertyTIFFModel: "Model 7", kCGImagePropertyTIFFOrientation: 6],
  kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2024:07:14 18:22:05", kCGImagePropertyExifOffsetTimeOriginal: "+02:00"],
  kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 47.3769, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 8.5417, kCGImagePropertyGPSLongitudeRef: "E"],
]
try! FileManager.default.createDirectory(at: out.appendingPathComponent("Trip/Day 2"), withIntermediateDirectories: true)
write(picture(4000, 3000, 1), "IMG_0001.JPG", .jpeg, camera)       // stored sideways, shown upright (orientation 6)
write(picture(4032, 3024, 2), "Trip/IMG_0002.HEIC", .heic, camera)
write(picture(1200, 800, 3), "Trip/Day 2/screen.png", .png, [:])
write(picture(500, 300, 4), "Trip/Day 2/small.gif", .gif, [:])

// a three-second video
let w = 1280, h = 720
let writer = try! AVAssetWriter(outputURL: out.appendingPathComponent("Trip/clip.mov"), fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for f in 0..<60 {
  while !input.isReadyForMoreMediaData { usleep(1000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  CVPixelBufferLockBaseAddress(pb!, [])
  let base = CVPixelBufferGetBaseAddress(pb!)!.assumingMemoryBound(to: UInt8.self)
  let bpr = CVPixelBufferGetBytesPerRow(pb!)
  for y in 0..<h { for x in 0..<w { let p = base + y * bpr + x * 4; p[0] = UInt8((x + f * 8) & 255); p[1] = UInt8(y & 255); p[2] = UInt8((x * y / 97) & 255); p[3] = 255 } }
  CVPixelBufferUnlockBaseAddress(pb!, [])
  adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 20))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
precondition(writer.status == .completed, "video")
