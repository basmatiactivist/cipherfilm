// On-device search (docs/SEARCH.md), the same pipeline as the Android app (mobile/modules/cf-native/.../Vision.kt), so an
// index entry made here matches one made on the phone: LAION's OpenCLIP ViT-B/32 for
// what is in a photo, YuNet to find faces and SFace to describe them. It reads decrypted pictures from memory and returns vectors; nothing is written anywhere.
import CoreGraphics
import Foundation
import ImageIO

/** An 8-bit RGBA picture in memory, like an Android ARGB_8888 bitmap. */
struct Pixels {
  var w: Int
  var h: Int
  var px: [UInt8] // r, g, b, a

  init(w: Int, h: Int, px: [UInt8]) { self.w = w; self.h = h; self.px = px }
  init(w: Int, h: Int) { self.init(w: w, h: h, px: [UInt8](repeating: 0, count: w * h * 4)) }

  /** The cw × ch part whose top left is at x, y. */
  func cropped(_ x: Int, _ y: Int, _ cw: Int, _ ch: Int) -> Pixels {
    if x == 0 && y == 0 && cw == w && ch == h { return self }
    var out = Pixels(w: cw, h: ch)
    for r in 0..<ch {
      let from = ((y + r) * w + x) * 4
      out.px.replaceSubrange(r * cw * 4..<(r + 1) * cw * 4, with: px[from..<from + cw * 4])
    }
    return out
  }

  /** Decodes a JPEG as stored (no EXIF rotation, no colour matching, like BitmapFactory), at a power-of-two reduction
   *  that keeps its long side at least maxPx/2. */
  static func decode(_ data: Data, maxPx: Int) -> Pixels? {
    guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let w0 = p[kCGImagePropertyPixelWidth] as? Int, let h0 = p[kCGImagePropertyPixelHeight] as? Int, w0 > 0, h0 > 0 else { return nil }
    var sample = 1
    while max(w0, h0) / (sample * 2) >= maxPx { sample *= 2 }
    let img: CGImage?
    if sample == 1 {
      img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    } else {
      img = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: false,
                                                         kCGImageSourceThumbnailMaxPixelSize: max(w0, h0) / sample] as CFDictionary)
    }
    guard let img else { return nil }
    return from(img)
  }

  /** The image's own RGB values: drawn in its own colour space (no conversion) when it has an RGB one. */
  static func from(_ img: CGImage) -> Pixels? {
    let w = img.width, h = img.height
    let cs = img.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ok = px.withUnsafeMutableBytes { b -> Bool in
      guard let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
      ctx.interpolationQuality = .none
      ctx.setBlendMode(.copy)
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
      return true
    }
    return ok ? Pixels(w: w, h: h, px: px) : nil
  }

  /** Bilinear scaling as Android's createScaledBitmap(filter = true) does it: sample at pixel centres, edges clamped. */
  func scaled(_ nw: Int, _ nh: Int) -> Pixels {
    if nw == w && nh == h { return self }
    var out = Pixels(w: nw, h: nh)
    let sx = Double(w) / Double(nw), sy = Double(h) / Double(nh)
    var xs0 = [Int](repeating: 0, count: nw), xs1 = xs0, fx = [Double](repeating: 0, count: nw)
    for x in 0..<nw {
      let s = max(0, (Double(x) + 0.5) * sx - 0.5)
      let x0 = min(w - 1, Int(s))
      xs0[x] = x0; xs1[x] = min(w - 1, x0 + 1); fx[x] = s - Double(x0)
    }
    px.withUnsafeBufferPointer { src in
      out.px.withUnsafeMutableBufferPointer { dst in
        for y in 0..<nh {
          let s = max(0, (Double(y) + 0.5) * sy - 0.5)
          let y0 = min(h - 1, Int(s)), y1 = min(h - 1, y0 + 1), fy = s - Double(y0)
          let r0 = y0 * w * 4, r1 = y1 * w * 4, o = y * nw * 4
          for x in 0..<nw {
            let a = r0 + xs0[x] * 4, b = r0 + xs1[x] * 4, c = r1 + xs0[x] * 4, d = r1 + xs1[x] * 4, f = fx[x]
            for k in 0..<4 {
              let top = Double(src[a + k]) * (1 - f) + Double(src[b + k]) * f
              let bot = Double(src[c + k]) * (1 - f) + Double(src[d + k]) * f
              dst[o + x * 4 + k] = UInt8(min(255, max(0, (top * (1 - fy) + bot * fy).rounded())))
            }
          }
        }
      }
    }
    return out
  }

  /** Resizing as Pillow's resize(BICUBIC) does it, the LAION model's reference: the cubic kernel (a = -0.5) widened by
   *  the scale factor, so a downscale averages instead of aliasing; horizontally, then vertically, 8 bits in between. */
  func bicubic(_ nw: Int, _ nh: Int) -> Pixels {
    func kernel(_ t: Double) -> Double {
      let a = -0.5, x = abs(t)
      if x < 1 { return ((a + 2) * x - (a + 3)) * x * x + 1 }
      if x < 2 { return (((x - 5) * x + 8) * x - 4) * a }
      return 0
    }
    func taps(_ size: Int, _ out: Int) -> [(lo: Int, w: [Double])] {
      let scale = Double(size) / Double(out), fs = max(scale, 1), support = 2 * fs
      return (0..<out).map { x in
        let center = (Double(x) + 0.5) * scale
        let lo = max(0, Int(center - support + 0.5)), hi = min(size, Int(center + support + 0.5))
        var w = (lo..<hi).map { kernel((Double($0) - center + 0.5) / fs) }
        let sum = w.reduce(0, +)
        if sum != 0 { w = w.map { $0 / sum } }
        return (lo, w)
      }
    }
    // one pass along a line of pixels: src and dst are RGBA, step is the distance between neighbours on the line
    func pass(_ src: UnsafeBufferPointer<UInt8>, _ dst: UnsafeMutableBufferPointer<UInt8>, lines: Int, inLen: Int, outLen: Int,
              srcLine: Int, srcStep: Int, dstLine: Int, dstStep: Int, _ t: [(lo: Int, w: [Double])]) {
      let flat = t.map { $0.w.map(Float.init) }
      for line in 0..<lines {
        let sb = line * srcLine, db = line * dstLine
        for o in 0..<outLen {
          let lo = t[o].lo, wt = flat[o]
          var r: Float = 0, g: Float = 0, b: Float = 0, a: Float = 0
          var p = sb + lo * srcStep
          for f in wt {
            r += Float(src[p]) * f; g += Float(src[p + 1]) * f; b += Float(src[p + 2]) * f; a += Float(src[p + 3]) * f
            p += srcStep
          }
          let q = db + o * dstStep
          dst[q] = UInt8(min(255, max(0, (r + 0.5).rounded(.down)))); dst[q + 1] = UInt8(min(255, max(0, (g + 0.5).rounded(.down))))
          dst[q + 2] = UInt8(min(255, max(0, (b + 0.5).rounded(.down)))); dst[q + 3] = UInt8(min(255, max(0, (a + 0.5).rounded(.down))))
        }
      }
    }
    var mid = self
    if nw != w {
      mid = Pixels(w: nw, h: h)
      let tx = taps(w, nw)
      px.withUnsafeBufferPointer { s in mid.px.withUnsafeMutableBufferPointer { d in
        pass(s, d, lines: h, inLen: w, outLen: nw, srcLine: w * 4, srcStep: 4, dstLine: nw * 4, dstStep: 4, tx)
      } }
    }
    if nh == h { return mid }
    var out = Pixels(w: nw, h: nh)
    let ty = taps(h, nh)
    mid.px.withUnsafeBufferPointer { s in out.px.withUnsafeMutableBufferPointer { d in
      pass(s, d, lines: nw, inLen: h, outLen: nh, srcLine: 4, srcStep: nw * 4, dstLine: 4, dstStep: nw * 4, ty)
    } }
    return out
  }

  /** Downscaling in halving steps, so a large image doesn't alias into the small model input (Vision.kt smooth()). */
  func smooth(_ nw: Int, _ nh: Int) -> Pixels {
    var cur = self
    while cur.w / 2 >= nw && cur.h / 2 >= nh { cur = cur.scaled(cur.w / 2, cur.h / 2) }
    return cur.scaled(nw, nh)
  }
}

public struct FaceFound: Sendable, Codable, Hashable {
  public var box: [Double] // x, y, w, h in 0..1 of the image
  public var score: Double
  public var emb: Data // float16 little-endian, 128 numbers
}

public struct Analysis: Sendable {
  public var clip: Data // float16 little-endian, 512 numbers
  public var faces: [FaceFound]?
}

/** One look at a photo: the image vector of each model asked for (one since MobileCLIP was dropped) and the faces. */
public struct Analyses: Sendable {
  public var clips: [(model: ClipModel, vector: Data)]
  public var faces: [FaceFound]?
  public init(clips: [(model: ClipModel, vector: Data)], faces: [FaceFound]?) { self.clips = clips; self.faces = faces }
}

public final class Vision: @unchecked Sendable {
  public static let clipDim = 512
  public static let faceDim = 128
  static let clipPx = 256
  static let detPx = 640
  static let faceScore: Float = 0.82

  public let model: ClipModel
  private let image: OrtModel?
  private let text: OrtModel
  private let det: OrtModel?
  private let rec: OrtModel?
  public var hasFaces: Bool { det != nil }

  /** Opens the models in a folder, each from bytes read once and checked against its pinned SHA-256 right there
   *  (Models.verified). textOnly: only the text model, on a device that reads the index another one computes; it can
   *  search but not look at photos. */
  public init(dir: URL, faces: Bool, clip: ClipModel = .clip, threads: Int32 = 2, textOnly: Bool = false) throws {
    model = clip
    func load(_ m: ModelFile) throws -> OrtModel { try OrtModel(bytes: Models.verified(m, in: dir), threads: threads) }
    image = textOnly ? nil : try load(clip.vision)
    text = try load(clip.text)
    if faces && !textOnly {
      det = try load(Models.faceFiles[0])
      rec = try load(Models.faceFiles[1])
    } else {
      det = nil; rec = nil
    }
  }

  public static var runtimeVersion: String { ORT.version }

  // ---- one photo ----

  /** The image vector and the faces in a JPEG. */
  public func analyze(_ jpeg: Data, faces: Bool) throws -> Analysis {
    let a = try analyze(jpeg, faces: faces, clips: [model])
    return Analysis(clip: a.clips[0].vector, faces: a.faces)
  }

  /** The image vector of each model in clips and the faces in a JPEG, found once. */
  public func analyze(_ jpeg: Data, faces: Bool, clips: [ClipModel]) throws -> Analyses {
    let run = try clips.map { m -> (ClipModel, OrtModel) in
      guard let s = m == model ? image : nil else { throw CryptoError.failed("this device only reads the index") }
      return (m, s)
    }
    guard let bmp = Pixels.decode(jpeg, maxPx: 1280) else { throw CryptoError.failed("not an image") }
    var out = Analyses(clips: try run.map { ($0.0, Self.half(Self.normalize(try clip(bmp, $0.0, $0.1)))) }, faces: nil)
    if faces, let det, let rec {
      out.faces = try detect(det, bmp).map { f in
        let box = [f.x / Float(bmp.w), f.y / Float(bmp.h), f.w / Float(bmp.w), f.h / Float(bmp.h)].map { (Double($0) * 10000).rounded() / 10000 }
        return FaceFound(box: box, score: (Double(f.score) * 1000).rounded() / 1000, emb: Self.half(Self.normalize(try embed(rec, bmp, f))))
      }
    }
    return out
  }

  /** The text vector for CLIP token ids (Tokenizer), L2-normalised. */
  public func textVector(_ ids: [Int]) throws -> [Float] {
    // Immich's export takes int32 ids
    var padded = [Int32](repeating: 0, count: 77)
    for (i, v) in ids.prefix(77).enumerated() { padded[i] = Int32(v) }
    return Self.normalize(try text.vector(.int32(padded, [1, 77]), dim: Self.clipDim))
  }

  // ---- shortest side to 224 (bicubic, as the Python reference's Pillow), centre crop, CLIP's mean and std ----

  static let laionMean: [Float] = [0.48145466, 0.4578275, 0.40821073]
  static let laionStd: [Float] = [0.26862954, 0.26130258, 0.27577711]

  /** The image model's input for a picture: [1, 3, P, P], channels first. */
  static func clipInput(_ src: Pixels, _ model: ClipModel) -> (buf: [Float], px: Int) {
    let P = 224
    let (mean, std) = (laionMean, laionStd)
    // a very long or tall picture: only its middle (at most 4 times the short side) is scaled, which is all the centre
    // crop below reads, so the scaled picture stays small however thin the original is
    let cap = 4 * min(src.w, src.h), cw = min(src.w, cap), ch = min(src.h, cap)
    let pic = src.cropped((src.w - cw) / 2, (src.h - ch) / 2, cw, ch)
    let scale = Float(P) / Float(min(pic.w, pic.h))
    let sw = max(P, Int((Float(pic.w) * scale).rounded())), sh = max(P, Int((Float(pic.h) * scale).rounded()))
    let sized = pic.bicubic(sw, sh)
    let l = (sized.w - P) / 2, t = (sized.h - P) / 2
    let n = P * P
    var buf = [Float](repeating: 0, count: 3 * n)
    for y in 0..<P {
      for x in 0..<P {
        let o = ((t + y) * sized.w + (l + x)) * 4, i = y * P + x
        for c in 0..<3 { buf[c * n + i] = (Float(sized.px[o + c]) / 255 - mean[c]) / std[c] }
      }
    }
    return (buf, P)
  }

  private func clip(_ src: Pixels, _ m: ClipModel, _ s: OrtModel) throws -> [Float] {
    let (buf, P) = Self.clipInput(src, m)
    return try s.vector(.float(buf, [1, 3, Int64(P), Int64(P)]), dim: Self.clipDim)
  }

  // ---- YuNet (OpenCV zoo, 2023mar): 640x640 BGR 0..255, three strides, score = sqrt(cls * obj) ----

  struct Face { var score: Float; var x: Float; var y: Float; var w: Float; var h: Float; var pts: [Float] }

  private func detect(_ s: OrtModel, _ src: Pixels) throws -> [Face] {
    let D = Self.detPx
    let scale = Float(D) / Float(max(src.w, src.h))
    let sw = max(1, Int((Float(src.w) * scale).rounded())), sh = max(1, Int((Float(src.h) * scale).rounded()))
    let sized = src.smooth(sw, sh)
    let n = D * D
    var buf = [Float](repeating: 0, count: 3 * n) // letterboxed at the top left, the rest black
    for y in 0..<sh {
      for x in 0..<sw {
        let o = (y * sw + x) * 4, i = y * D + x
        buf[i] = Float(sized.px[o + 2]); buf[n + i] = Float(sized.px[o + 1]); buf[2 * n + i] = Float(sized.px[o])
      }
    }
    let r = try s.run(.float(buf, [1, 3, Int64(D), Int64(D)]))
    var found: [Face] = []
    for st in [8, 16, 32] {
      guard let cls = r["cls_\(st)"], let obj = r["obj_\(st)"], let bb = r["bbox_\(st)"], let kp = r["kps_\(st)"] else { continue }
      let cols = D / st
      // one score, one box (4) and five points (10) per grid cell
      guard cls.count == cols * cols, obj.count == cls.count, bb.count == 4 * cls.count, kp.count == 10 * cls.count else { throw CryptoError.failed("ONNX Runtime: unexpected face detector output") }
      for i in 0..<cls.count {
        let sc = sqrt(min(1, max(0, cls[i])) * min(1, max(0, obj[i])))
        if sc < Self.faceScore { continue }
        let row = Float(i / cols), col = Float(i % cols), fs = Float(st)
        let cx = (col + bb[i * 4]) * fs, cy = (row + bb[i * 4 + 1]) * fs
        let w = exp(bb[i * 4 + 2]) * fs, h = exp(bb[i * 4 + 3]) * fs
        let pts = (0..<10).map { k in ((k % 2 == 0 ? col : row) + kp[i * 10 + k]) * fs / scale }
        found.append(Face(score: sc, x: (cx - w / 2) / scale, y: (cy - h / 2) / scale, w: w / scale, h: h / scale, pts: pts))
      }
    }
    found.sort { $0.score > $1.score }
    var keep: [Face] = []
    for f in found where !keep.contains(where: { Self.iou($0, f) > 0.3 }) { keep.append(f) }
    return Array(keep.prefix(30))
  }

  static func iou(_ a: Face, _ b: Face) -> Float {
    let x1 = max(a.x, b.x), y1 = max(a.y, b.y), x2 = min(a.x + a.w, b.x + b.w), y2 = min(a.y + a.h, b.y + b.h)
    let i = max(0, x2 - x1) * max(0, y2 - y1)
    let u = a.w * a.h + b.w * b.h - i
    return u > 0 ? i / u : 0
  }

  // ---- SFace: the face turned upright onto ArcFace's 112x112 landmark positions, RGB 0..255 ----

  static let ref: [Float] = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041]

  private func embed(_ s: OrtModel, _ src: Pixels, _ f: Face) throws -> [Float] {
    // least-squares similarity transform (rotation, scale, shift) from the five landmarks to the reference points
    var msx: Float = 0, msy: Float = 0, mdx: Float = 0, mdy: Float = 0
    for k in 0..<5 { msx += f.pts[2 * k]; msy += f.pts[2 * k + 1]; mdx += Self.ref[2 * k]; mdy += Self.ref[2 * k + 1] }
    msx /= 5; msy /= 5; mdx /= 5; mdy /= 5
    var vr: Float = 0, a: Float = 0, b: Float = 0
    for k in 0..<5 {
      let sx = f.pts[2 * k] - msx, sy = f.pts[2 * k + 1] - msy, dx = Self.ref[2 * k] - mdx, dy = Self.ref[2 * k + 1] - mdy
      vr += sx * sx + sy * sy; a += dx * sx + dy * sy; b += dy * sx - dx * sy
    }
    let norm = hypot(a, b), scale = norm / vr, c = a / norm * scale, sn = b / norm * scale
    let tx = mdx - (c * msx - sn * msy), ty = mdy - (sn * msx + c * msy)
    // the inverse maps each output pixel's centre back into the photo; bilinear, black outside (Canvas.drawBitmap)
    let det = c * c + sn * sn
    let n = 112 * 112
    var buf = [Float](repeating: 0, count: 3 * n)
    for y in 0..<112 {
      for x in 0..<112 {
        let ox = Float(x) + 0.5 - tx, oy = Float(y) + 0.5 - ty
        let sx = (c * ox + sn * oy) / det - 0.5, sy = (-sn * ox + c * oy) / det - 0.5
        let x0 = Int(floor(sx)), y0 = Int(floor(sy)), fx = sx - Float(x0), fy = sy - Float(y0)
        var rgb: (Float, Float, Float) = (0, 0, 0)
        for (dx, dy, wgt) in [(0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)] {
          let px = x0 + dx, py = y0 + dy
          guard px >= 0, py >= 0, px < src.w, py < src.h, wgt > 0 else { continue }
          let o = (py * src.w + px) * 4
          rgb.0 += Float(src.px[o]) * wgt; rgb.1 += Float(src.px[o + 1]) * wgt; rgb.2 += Float(src.px[o + 2]) * wgt
        }
        let i = y * 112 + x
        buf[i] = min(255, rgb.0.rounded()); buf[n + i] = min(255, rgb.1.rounded()); buf[2 * n + i] = min(255, rgb.2.rounded())
      }
    }
    return try s.vector(.float(buf, [1, 3, 112, 112]), dim: Self.faceDim)
  }

  /** A square crop around a face (box in 0..1 of the image), for the people list. */
  public static func faceCrop(_ jpeg: Data, box: [Double], px: Int) -> CGImage? {
    guard box.count == 4, box.allSatisfy(\.isFinite), let img = Media.decodeBounded(jpeg) else { return nil }
    let W = Double(img.width), H = Double(img.height)
    let cx = (box[0] + box[2] / 2) * W, cy = (box[1] + box[3] / 2) * H
    let side = max(8, max(box[2] * W, box[3] * H) * 1.5)
    let l = min(max(0, cx - side / 2), W - 1), t = min(max(0, cy - side / 2), H - 1)
    let s = max(1, min(side, min(W - l, H - t)))
    guard let crop = img.cropping(to: CGRect(x: l, y: t, width: s, height: s)) else { return nil }
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    ctx?.interpolationQuality = .high
    ctx?.draw(crop, in: CGRect(x: 0, y: 0, width: px, height: px))
    return ctx?.makeImage()
  }

  // ---- vectors ----

  public static func normalize(_ v: [Float]) -> [Float] {
    var s = 0.0
    for x in v { s += Double(x) * Double(x) }
    let n = Float(sqrt(s))
    let d = n > 0 ? n : 1
    return v.map { $0 / d }
  }

  /** float16 little-endian, rounded to nearest even like android.util.Half.toHalf. */
  public static func half(_ v: [Float]) -> Data {
    var d = Data(capacity: v.count * 2)
    for x in v { withUnsafeBytes(of: Float16(x).bitPattern.littleEndian) { d.append(contentsOf: $0) } }
    return d
  }

  public static func unhalf(_ d: Data) -> [Float] {
    let b = [UInt8](d)
    return (0..<(b.count / 2)).map { Float(Float16(bitPattern: UInt16(b[2 * $0]) | UInt16(b[2 * $0 + 1]) << 8)) }
  }
}
