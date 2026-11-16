// Text in photos (docs/SEARCH.md): the Mac reads the shared test picture exactly as scripts/ocr-reference.py does, and
// index entries carry the text in a slot of fixed size. The model test runs with CF_OCR_MODELS or CF_MODELS (a folder
// with ocr-det-v3.onnx, ocr-rec-latin-v5.onnx and ocr-latin-dict.txt, server/models.json); -c release for times:
//   CF_OCR_MODELS=<folder> ./scripts/test.sh -c release --filter Ocr
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private func hasOcr(_ m: URL) -> Bool { Models.ocrFiles.allSatisfy { FileManager.default.fileExists(atPath: m.appendingPathComponent($0.name).path) } }
private let models = ["CF_OCR_MODELS", "CF_MODELS"].compactMap { ProcessInfo.processInfo.environment[$0].map { URL(fileURLWithPath: $0) } }.first(where: hasOcr)
private let haveOcr = models != nil

private func ms(_ runs: Int, _ f: () throws -> Void) rethrows -> Double {
  let t = Date()
  for _ in 0..<runs { try f() }
  return Date().timeIntervalSince(t) / Double(runs) * 1000
}

@Suite struct OcrTests {
  @Test(.enabled(if: haveOcr)) func readsTheFixtureLikeTheReference() throws {
    let ocr = try Ocr(dir: models!, threads: 2)
    #expect(ocr.chars.count == 502)
    let jpeg = try Data(contentsOf: repo.appendingPathComponent("web/src/search/ocr-fixture.jpg"))
    let text = Ocr.normalize(try ocr.read(jpeg))
    #expect(text == "BAKERY OPEN Zürich Hauptbahnhof Gleis 7 Fresh bread daily")
    let bmp = Pixels.decode(jpeg, maxPx: 1280)!
    let fixture = try ms(5) { _ = try ocr.read(bmp) }
    print("ocr fixture \(bmp.w)x\(bmp.h): \(Int(fixture.rounded())) ms (det+rec, warm, mean of 5, 2 threads)")
    // where the time goes
    var x = Ocr.detInput(bmp)
    let prep = ms(5) { x = Ocr.detInput(bmp) }
    let name = ocr.det.outputNames[0]
    var prob: [Float] = []
    let det = try ms(5) { prob = try ocr.det.run(.float(x.buf, [1, 3, Int64(x.h), Int64(x.w)]), outputs: [name])[name]! }
    let regions = ms(5) { _ = Ocr.regions(prob, w: x.w, h: x.h) }
    print("ocr fixture parts: resize+normalise \(Int(prep.rounded())) ms, detector \(Int(det.rounded())) ms, regions \(Int(regions.rounded())) ms, the rest (\(Ocr.regions(prob, w: x.w, h: x.h).count) lines recognised) \(Int((fixture - prep - det - regions).rounded())) ms")
    // larger, busier pictures: screenshots full of text
    for name in ["web-map.png", "android-search.png", "android-details.png"] {
      let url = repo.appendingPathComponent("docs/screenshots/\(name)")
      guard let d = try? Data(contentsOf: url), let p = Pixels.decode(d, maxPx: 1280) else { continue }
      var lines: [String] = []
      _ = try ocr.read(p)
      let t = try ms(3) { lines = try ocr.read(p) }
      print("ocr \(name) \(p.w)x\(p.h): \(Int(t.rounded())) ms, \(lines.count) lines: \(Ocr.normalize(lines).prefix(120))")
    }
  }

  @Test func pillowRounding() {
    #expect(Ocr.pyRound(2.5) == 2 && Ocr.pyRound(3.5) == 4 && Ocr.pyRound(-0.5) == 0)
  }

  @Test func turnsStandingTextLeft() {
    // 2 wide, 3 high; values are the pixel's number
    var p = Pixels(w: 2, h: 3)
    for i in 0..<6 { p.px[i * 4] = UInt8(i) }
    let r = Ocr.rotatedLeft(p)
    #expect(r.w == 3 && r.h == 2)
    // Pillow's ROTATE_90: [[0,1],[2,3],[4,5]] → [[1,3,5],[0,2,4]]
    #expect((0..<6).map { r.px[$0 * 4] } == [1, 3, 5, 0, 2, 4])
  }

  @Test func dictionaryKeepsEveryLine() {
    #expect(Ocr.dictionary(Data("a\n \nb\r\n".utf8)) == ["a", " ", "b\r"])
    #expect(Ocr.dictionary(Data("a\nb".utf8)) == ["a", "b"])
  }

  @Test func regionsInReadingOrder() {
    // two blocks on one line (the right one starts higher, so the row scan finds it first) and one below; a speck
    // too small to keep, and a faint region
    let w = 40, h = 30
    var p = [Float](repeating: 0, count: w * h)
    func fill(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, _ v: Float = 0.9) { for y in y0...y1 { for x in x0...x1 { p[y * w + x] = v } } }
    fill(25, 2, 35, 6)   // right, starts higher
    fill(2, 3, 12, 7)    // left, same line (round(y0 / 8) the same)
    fill(2, 18, 20, 22)  // below
    fill(30, 25, 31, 26) // 2x2: dropped
    fill(30, 12, 36, 16, 0.4) // above the threshold but its mean under 0.6: dropped
    let r = Ocr.regions(p, w: w, h: h)
    #expect(r.count == 3)
    #expect(r.map { Int($0.x0.rounded(.up)) } == [0, 23, 0])
  }
}

@Suite struct IndexEntryTextTests {
  private func entry(_ text: String?) -> IndexEntry {
    var e = IndexEntry(vector: Data(repeating: 1, count: 1024), faces: [], model: .clip)
    e.setText(text)
    return e
  }

  @Test func sameSizeWhateverTheText() throws {
    let enc = JSONEncoder(); enc.outputFormatting = [.withoutEscapingSlashes]
    let sizes = try ["", "BAKERY OPEN", "Zürich \"Gleis\" 7 / Ausgang\\West\n\tNord", String(repeating: "€uro ", count: 400), "\u{2028}x\u{7f}"].map { try enc.encode(entry($0)).count }
    #expect(Set(sizes).count == 1, "\(sizes)")
    let e = entry("Zürich  Gleis 7")
    #expect(e.o == IndexEntry.ocrTag && e.text == "Zürich Gleis 7" && e.m == ClipModel.clip.tag && e.v == 1)
  }

  @Test func withoutTextTheEntryIsAsBefore() throws {
    let enc = JSONEncoder(); enc.outputFormatting = [.withoutEscapingSlashes]
    let s = String(decoding: try enc.encode(entry(nil)), as: UTF8.self)
    #expect(!s.contains("\"o\"") && !s.contains("\"t\""))
    // an entry from before text in photos opens, with no text
    let old = try JSONDecoder().decode(IndexEntry.self, from: Data(#"{"v":1,"m":"laionb32/1","clip":"AAAA"}"#.utf8))
    #expect(old.o == nil && old.t == nil && old.text == "")
    // and one with text, as the web app writes it
    let web = try JSONDecoder().decode(IndexEntry.self, from: Data(#"{"v":1,"m":"laionb32/1","clip":"AAAA","o":"ppocr3det+ppocr5latin/1","t":"OPEN   "}"#.utf8))
    #expect(web.text == "OPEN")
  }

  @Test func sealsAndOpens() throws {
    let kp = Sodium.boxKeypair()
    let pair = KeyPair(pk: kp.pk, sk: kp.sk)
    let id = String(repeating: "ab", count: 16)
    let blob = try entry("Fresh bread").seal(pk: pair.pk, itemId: id)
    let back = try IndexEntry.open(blob, pair: pair, itemId: id)
    #expect(back.text == "Fresh bread" && back.o == IndexEntry.ocrTag)
  }
}
