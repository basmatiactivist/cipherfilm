// A photo turned and cropped in the web or Android app (docs/EDITING.md): the encrypted original is never changed, the
// item's encrypted metadata says what to do with it, and the apps store a new thumbnail and preview made with it. This
// Mac shows the edit (the original in the viewer is drawn turned and cropped); it doesn't make edits. The rules are
// web/src/edit/edit.ts's: the turn is clockwise, the crop a fraction (0..1) of the turned picture.
import CoreGraphics
import Foundation

public struct CropRect: Codable, Sendable, Hashable {
  public var x: Double, y: Double, w: Double, h: Double
  public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
  public static let full = CropRect(x: 0, y: 0, w: 1, h: 1)
}

public struct PictureEdit: Codable, Sendable, Hashable {
  /** 0, 90, 180 or 270, clockwise */
  public var rot: Int
  /** nil: the whole (turned) picture */
  public var crop: CropRect?
  /** the version of the thumbnail and preview made for it (the cache key) */
  public var v: String?

  public static let minCrop = 0.02

  public init(rot: Int = 0, crop: CropRect? = nil, v: String? = nil) {
    self.rot = Self.turn(Double(rot)); self.crop = crop.flatMap(Self.normRect); self.v = v.flatMap(Self.version)
  }

  /** Written by any device: whatever doesn't make sense becomes "no edit" instead of making the item unreadable. */
  public init(from decoder: Decoder) {
    let c = try? decoder.container(keyedBy: CodingKeys.self)
    let r = (try? c?.decodeIfPresent(Double.self, forKey: .rot)) ?? (try? c?.decodeIfPresent(String.self, forKey: .rot)).flatMap { Double($0) }
    rot = Self.turn(r ?? 0)
    crop = ((try? c?.decodeIfPresent(CropRect.self, forKey: .crop)) ?? nil).flatMap(Self.normRect)
    v = ((try? c?.decodeIfPresent(String.self, forKey: .v)) ?? nil).flatMap(Self.version)
  }

  public var isIdentity: Bool { rot == 0 && crop == nil }

  static func turn(_ r: Double) -> Int {
    guard r.isFinite, r.truncatingRemainder(dividingBy: 90) == 0 else { return 0 }
    let n = Int(r.truncatingRemainder(dividingBy: 360))
    return (n + 360) % 360
  }

  static func version(_ s: String) -> String? {
    (1...16).contains(s.count) && s.allSatisfy({ ("0"..."9").contains($0) || ("a"..."z").contains($0) }) ? s : nil
  }

  private static func round4(_ v: Double) -> Double { (v * 1e4).rounded() / 1e4 }

  /** Inside the picture, at least minCrop on each side; nil for the whole picture or for something that isn't one. */
  static func normRect(_ r: CropRect) -> CropRect? {
    guard [r.x, r.y, r.w, r.h].allSatisfy(\.isFinite) else { return nil }
    var x0 = min(1, max(0, r.x)), y0 = min(1, max(0, r.y))
    var x1 = min(1, max(0, r.x + r.w)), y1 = min(1, max(0, r.y + r.h))
    if x1 - x0 < minCrop { x1 = min(1, x0 + minCrop); x0 = x1 - minCrop }
    if y1 - y0 < minCrop { y1 = min(1, y0 + minCrop); y0 = y1 - minCrop }
    let out = CropRect(x: round4(x0), y: round4(y0), w: round4(x1 - x0), h: round4(y1 - y0))
    return out == .full ? nil : out
  }

  /** A rectangle of a picture, where it is after the picture is turned clockwise by `by`. */
  public static func rotate(_ r: CropRect, by: Int) -> CropRect {
    var o = r
    for _ in 0..<(turn(Double(by)) / 90) { o = CropRect(x: 1 - (o.y + o.h), y: o.x, w: o.h, h: o.w) }
    return CropRect(x: round4(o.x), y: round4(o.y), w: round4(o.w), h: round4(o.h))
  }

  /** The crop as a fraction of the original, unturned picture. */
  public var sourceRect: CropRect { Self.rotate(crop ?? .full, by: (360 - rot) % 360) }

  public struct Plan: Equatable, Sendable {
    public var sx, sy, sw, sh, dw, dh, rot, outW, outH: Int
  }

  /** As drawPlan in edit.ts: take sx, sy, sw, sh of the upright original (y from the top), scale it to dw × dh, turn it
   *  by rot; the result is outW × outH, at most maxPx on its longer side (0: full size). */
  public func plan(width: Int, height: Int, maxPx: Int = 0) -> Plan {
    let s = sourceRect
    let sx = Int((s.x * Double(width)).rounded()), sy = Int((s.y * Double(height)).rounded())
    let sw = max(1, min(width - sx, Int((s.w * Double(width)).rounded()))), sh = max(1, min(height - sy, Int((s.h * Double(height)).rounded())))
    let scale = maxPx > 0 ? min(1, Double(maxPx) / Double(max(sw, sh))) : 1
    let dw = max(1, Int((Double(sw) * scale).rounded())), dh = max(1, Int((Double(sh) * scale).rounded()))
    let quarter = rot % 180 != 0
    return Plan(sx: sx, sy: sy, sw: sw, sh: sh, dw: dw, dh: dh, rot: rot, outW: quarter ? dh : dw, outH: quarter ? dw : dh)
  }

  /** The upright original turned and cropped (nil if it can't be drawn). */
  public func apply(to img: CGImage, maxPx: Int = 0) -> CGImage? {
    if isIdentity && maxPx == 0 { return img }
    let p = plan(width: img.width, height: img.height, maxPx: maxPx)
    guard let part = img.cropping(to: CGRect(x: p.sx, y: p.sy, width: p.sw, height: p.sh)),
          let ctx = CGContext(data: nil, width: p.outW, height: p.outH, bitsPerComponent: 8, bytesPerRow: 0,
                              space: img.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.interpolationQuality = .high
    // Core Graphics turns counter-clockwise with y up: a clockwise turn on screen is a negative angle
    ctx.translateBy(x: CGFloat(p.outW) / 2, y: CGFloat(p.outH) / 2)
    ctx.rotate(by: -CGFloat(p.rot) * .pi / 180)
    ctx.draw(part, in: CGRect(x: -CGFloat(p.dw) / 2, y: -CGFloat(p.dh) / 2, width: CGFloat(p.dw), height: CGFloat(p.dh)))
    return ctx.makeImage()
  }
}

public extension Item {
  /** The key thumbnails and previews are cached under: a new one whenever an edit made new pictures. */
  var pictureKey: String {
    if let e = meta?.edit, !e.isIdentity, let v = e.v { return "\(id).\(v)" }
    return id
  }
  /** Turned or cropped somewhere; the original is kept as it was. */
  var isEditedPicture: Bool { !(meta?.edit?.isIdentity ?? true) }
}
