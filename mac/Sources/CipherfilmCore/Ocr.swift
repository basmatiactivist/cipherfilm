// Text in photos (docs/SEARCH.md "Text in photos"): PP-OCRv3's text detector and PP-OCRv5's Latin recogniser
// (PaddleOCR, Apache-2.0; files in server/models.json), the same steps as scripts/ocr-reference.py (the reference, its
// constants below) and the Android app's Ocr.kt, so the three read a photo alike. It reads decrypted pictures from
// memory and returns text; nothing is written anywhere. Only the indexing device runs it.
import Foundation

public final class Ocr: @unchecked Sendable {
  static let detSide = 960          // the longest side the detector sees (multiples of 32)
  static let detMean: [Float] = [0.485, 0.456, 0.406]  // applied in BGR order, as the reference does
  static let detStd: [Float] = [0.229, 0.224, 0.225]
  static let bin: Float = 0.3       // a pixel is text above this
  static let box = 0.6              // a region is kept when its mean is at least this
  static let unclip = 1.5           // regions grow by area * unclip / perimeter on every side
  static let minSide = 3            // regions smaller than this (detector pixels) are dropped
  static let recH = 48
  static let recMaxW = 960          // a line wider than this (after scaling to 48 px high) is squeezed
  static let recMinScore: Float = 0.5 // a line's mean character confidence
  static let maxLines = 40

  /** The three files (server/models.json), in the order they are loaded. */
  public static var files: [ModelFile] { Models.ocrFiles }

  let det: OrtModel
  let rec: OrtModel
  let chars: [String]

  /** Opens the models in a folder, each from bytes read once and checked against its pinned SHA-256 (Models.verified). */
  public init(dir: URL, threads: Int32 = 2) throws {
    let f = Models.ocrFiles
    det = try OrtModel(bytes: Models.verified(f[0], in: dir), threads: threads)
    rec = try OrtModel(bytes: Models.verified(f[1], in: dir), threads: threads)
    chars = Self.dictionary(try Models.verified(f[2], in: dir))
  }

  /** The recogniser's characters: the file split at "\n" (only), a last empty line dropped, as the reference reads it. */
  static func dictionary(_ d: Data) -> [String] {
    var out = d.split(separator: 0x0A, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
    if out.last == "" { out.removeLast() }
    return out
  }

  // ---- one picture ----

  /** The lines of text in a JPEG, in reading order. */
  public func read(_ jpeg: Data) throws -> [String] {
    guard let bmp = Pixels.decode(jpeg, maxPx: 1280) else { throw CryptoError.failed("not an image") }
    return try read(bmp)
  }

  /** One line of words, as stored: whitespace collapsed (Python's str.split()). */
  public static func normalize(_ lines: [String]) -> String {
    lines.joined(separator: " ").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }

  func read(_ img: Pixels) throws -> [String] {
    let (x, nw, nh) = Self.detInput(img)
    let name = det.outputNames[0]
    guard let prob = try det.run(.float(x, [1, 3, Int64(nh), Int64(nw)]), outputs: [name])[name], prob.count == nw * nh else {
      throw CryptoError.failed("ONNX Runtime: unexpected text detector output")
    }
    let sx = Double(img.w) / Double(nw), sy = Double(img.h) / Double(nh)
    var lines: [String] = []
    for r in Self.regions(prob, w: nw, h: nh).prefix(Self.maxLines) {
      let l = max(0, Int(r.x0 * sx)), t = max(0, Int(r.y0 * sy))
      let rr = min(img.w, Int((r.x1 * sx).rounded(.up))), b = min(img.h, Int((r.y1 * sy).rounded(.up)))
      if rr - l < 4 || b - t < 4 { continue }
      let (input, w) = Self.recInput(img.cropped(l, t, rr - l, b - t))
      let out = rec.outputNames[0]
      guard let logits = try rec.run(.float(input, [1, 3, Int64(Self.recH), Int64(w)]), outputs: [out])[out] else { continue }
      let (text, score) = ctc(logits)
      let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if score >= Self.recMinScore && !line.isEmpty { lines.append(line) }
    }
    return lines
  }

  /** Python's round(): halves to the even neighbour. */
  static func pyRound(_ v: Double) -> Int { Int(v.rounded(.toNearestOrEven)) }

  /** The detector's input: longest side at most detSide, each side a multiple of 32; BGR, (x/255 − mean)/std. */
  static func detInput(_ img: Pixels) -> (buf: [Float], w: Int, h: Int) {
    let s = min(1.0, Double(detSide) / Double(max(img.w, img.h)))
    let nw = max(32, pyRound(Double(img.w) * s / 32) * 32), nh = max(32, pyRound(Double(img.h) * s / 32) * 32)
    let sized = img.bilinearPIL(nw, nh)
    return (planesBGR(sized, mean: detMean, std: detStd), nw, nh)
  }

  /** Channels first in BGR order: plane c holds channel 2−c, as (x/255 − mean[c]) / std[c]. */
  static func planesBGR(_ p: Pixels, mean: [Float], std: [Float]) -> [Float] {
    let n = p.w * p.h
    var buf = [Float](repeating: 0, count: 3 * n)
    p.px.withUnsafeBufferPointer { px in
      buf.withUnsafeMutableBufferPointer { b in
        for i in 0..<n {
          for c in 0..<3 { b[c * n + i] = (Float(px[i * 4 + 2 - c]) / 255 - mean[c]) / std[c] }
        }
      }
    }
    return buf
  }

  struct Region { var x0: Double; var y0: Double; var x1: Double; var y1: Double }

  /** Connected text pixels (4-neighbours), as axis-aligned boxes grown by the unclip distance, in reading order. */
  static func regions(_ prob: [Float], w: Int, h: Int) -> [Region] {
    var seen = [Bool](repeating: false, count: w * h)
    var out: [(Region, Int)] = []
    var stack: [Int] = []
    prob.withUnsafeBufferPointer { p in
      for y in 0..<h {
        for x in 0..<w {
          let i0 = y * w + x
          if !(p[i0] > bin) || seen[i0] { continue }
          stack.removeAll(keepingCapacity: true)
          stack.append(i0); seen[i0] = true
          var x0 = x, x1 = x, y0 = y, y1 = y
          var total = 0.0, n = 0
          while let i = stack.popLast() {
            let cy = i / w, cx = i % w
            total += Double(p[i]); n += 1
            x0 = min(x0, cx); x1 = max(x1, cx); y0 = min(y0, cy); y1 = max(y1, cy)
            // the reference's order: up, down, left, right
            if cy > 0, p[i - w] > bin, !seen[i - w] { seen[i - w] = true; stack.append(i - w) }
            if cy < h - 1, p[i + w] > bin, !seen[i + w] { seen[i + w] = true; stack.append(i + w) }
            if cx > 0, p[i - 1] > bin, !seen[i - 1] { seen[i - 1] = true; stack.append(i - 1) }
            if cx < w - 1, p[i + 1] > bin, !seen[i + 1] { seen[i + 1] = true; stack.append(i + 1) }
          }
          let bw = x1 - x0 + 1, bh = y1 - y0 + 1
          if min(bw, bh) < minSide || total / Double(n) < box { continue }
          let d = Double(bw * bh) * unclip / Double(2 * (bw + bh))
          out.append((Region(x0: Double(x0) - d, y0: Double(y0) - d, x1: Double(x1 + 1) + d, y1: Double(y1 + 1) + d), out.count))
        }
      }
    }
    // by line (round(y0 / 8)), then from the left; ties keep the order found (Python's sort is stable)
    out.sort { a, b in
      let ra = pyRound(a.0.y0 / 8), rb = pyRound(b.0.y0 / 8)
      if ra != rb { return ra < rb }
      if a.0.x0 != b.0.x0 { return a.0.x0 < b.0.x0 }
      return a.1 < b.1
    }
    return out.map(\.0)
  }

  /** The recogniser's input for a crop: standing text turned (90° counter-clockwise), 48 px high, width clamped to
   *  [8, recMaxW]; BGR, (x/255 − 0.5)/0.5. */
  static func recInput(_ crop: Pixels) -> (buf: [Float], w: Int) {
    var c = crop
    if Double(c.h) > Double(c.w) * 1.5 { c = rotatedLeft(c) }
    let nw = max(8, min(recMaxW, pyRound(Double(c.w) * Double(recH) / Double(c.h))))
    let sized = c.bilinearPIL(nw, recH)
    return (planesBGR(sized, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5]), nw)
  }

  /** Turned 90° counter-clockwise (Pillow's ROTATE_90): the top right corner becomes the top left. */
  static func rotatedLeft(_ p: Pixels) -> Pixels {
    var out = Pixels(w: p.h, h: p.w)
    for oy in 0..<out.h {
      for ox in 0..<out.w {
        let from = (ox * p.w + (p.w - 1 - oy)) * 4, to = (oy * out.w + ox) * 4
        for k in 0..<4 { out.px[to + k] = p.px[from + k] }
      }
    }
    return out
  }

  /** CTC greedy decoding: the best class per step, blanks (0) and repeats skipped; class k is chars[k − 1], the one
   *  after the dictionary a space. Score: the mean probability of the steps kept. */
  func ctc(_ logits: [Float]) -> (String, Float) {
    let classes = chars.count + 2
    guard classes > 0, logits.count % classes == 0 else { return ("", 0) }
    var out = "", scores: [Float] = [], last = 0
    for t in 0..<(logits.count / classes) {
      let row = logits[(t * classes)..<((t + 1) * classes)]
      var best = 0, p = -Float.infinity
      for (k, v) in zip(0..., row) where v > p { best = k; p = v } // the first of equal maxima, as numpy's argmax
      if best != 0 && best != last {
        out += best - 1 < chars.count ? chars[best - 1] : " "
        scores.append(p)
      }
      last = best
    }
    return (out, scores.isEmpty ? 0 : scores.reduce(0, +) / Float(scores.count))
  }
}
