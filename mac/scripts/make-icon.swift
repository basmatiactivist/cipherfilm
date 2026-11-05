// Makes the macOS app icon (Sources/Cipherfilm/Resources/AppIcon.icns) from design/icon/icon-1024.png: the mark on a
// paper rounded square inside Apple's icon grid (824 of 1024 px), the same artwork as the web and Android icons.
// Run: swift scripts/make-icon.swift   (from mac/)
import AppKit

let src = NSImage(contentsOfFile: "../design/icon/icon-1024.png")!
let set = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: set)
try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                             isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024
  let tile = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
  let path = NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s)
  NSGraphicsContext.current?.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor(white: 0, alpha: 0.22); shadow.shadowBlurRadius = 18 * s; shadow.shadowOffset = NSSize(width: 0, height: -6 * s)
  shadow.set()
  NSColor(srgbRed: 0xFA / 255, green: 0xF7 / 255, blue: 0xF2 / 255, alpha: 1).setFill()
  path.fill()
  NSGraphicsContext.current?.restoreGraphicsState()
  path.addClip()
  src.draw(in: tile, from: .zero, operation: .sourceOver, fraction: 1)
  NSColor(srgbRed: 0xCF / 255, green: 0xC6 / 255, blue: 0xB6 / 255, alpha: 0.6).setStroke()
  path.lineWidth = max(1, 2 * s)
  path.stroke()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256),
                   ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
  try! render(px).write(to: set.appendingPathComponent("icon_\(name).png"))
}
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", set.path, "-o", "Sources/Cipherfilm/Resources/AppIcon.icns"]
try! p.run(); p.waitUntilExit()
print(p.terminationStatus == 0 ? "AppIcon.icns written" : "iconutil failed")
