// The tokenizer must give Hugging Face's ids (the same table as mobile/src/search/tokenizer.test.ts), and the vision
// pipeline must run the real models. Set CF_MODELS to a folder with the five model files to run the model tests.
import CoreGraphics
import Foundation
import Testing
@testable import CipherfilmCore

private let models = ProcessInfo.processInfo.environment["CF_MODELS"].map { URL(fileURLWithPath: $0) }
private let haveModels = models.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("mobileclip-s2-vision.onnx").path) } ?? false

@Suite struct SearchTests {
  @Test func preTokenizer() {
    #expect(Tokenizer.words("It's  Mom's CAR, 2023!") == ["it", "'s", "mom", "'s", "car", ",", "2", "0", "2", "3", "!"])
    #expect(Tokenizer.words("snow-covered") == ["snow", "-", "covered"])
  }

  @Test(.enabled(if: haveModels)) func tokenizerIds() throws {
    let t = try Tokenizer(json: Data(contentsOf: models!.appendingPathComponent("mobileclip-s2-tokenizer.json")))
    let expected: [String: [Int]] = [
      "a dog": [49406, 320, 1929, 49407],
      "A photo of a DOG on the beach!": [49406, 320, 1125, 539, 320, 1929, 525, 518, 2117, 256, 49407],
      "sunset over mountains": [49406, 3424, 962, 5873, 49407],
      "birthday cake 2023": [49406, 1166, 2972, 273, 271, 273, 274, 49407],
      "it's mom's car": [49406, 585, 568, 2543, 568, 1615, 49407],
      "Café in Zürich": [49406, 15304, 530, 89, 6522, 4021, 49407],
      "  multiple   spaces\tand tabs": [49406, 6470, 9006, 537, 29163, 49407],
      "snow-covered trees, 3 kids": [49406, 2583, 268, 5603, 4682, 267, 274, 1911, 49407],
      "emoji 🎉 party": [49406, 16327, 3986, 1580, 49407],
    ]
    for (text, ids) in expected { #expect(t.encode(text) == ids, "\(text)") }
    #expect(t.encode(String(repeating: "word ", count: 200)).count == 77)
  }

  @Test func halfFloats() {
    let v: [Float] = [0, 1, -1, 0.5, 0.0001, 65504, 0.33333]
    let back = Vision.unhalf(Vision.half(v))
    for (a, b) in zip(v, back) { #expect(abs(a - b) <= max(abs(a) * 0.001, 0.0001)) }
    #expect(Vision.half([1]) == Data([0x00, 0x3c]))
  }

  @Test func indexAndClusters() {
    let idx = SearchIndex()
    func vec(_ i: Int) -> [Float] { var v = [Float](repeating: 0, count: 512); v[i] = 1; return v }
    idx.put("a", clip: Vision.half(vec(0)), faces: [])
    idx.put("b", clip: Vision.half(Vision.normalize(vec(0).enumerated().map { $0.offset == 1 ? 0.2 : $0.element })), faces: [])
    idx.put("c", clip: Vision.half(vec(5)), faces: [])
    #expect(idx.search(vec(0), limit: 10, minScore: 0.5).map(\.id) == ["a", "b"])
    #expect(idx.similar("a", limit: 10, minScore: 0.5).map(\.id) == ["b"])
    idx.remove("a")
    #expect(idx.search(vec(0), limit: 10, minScore: 0.5).map(\.id) == ["b"])
    var f = [Float](repeating: 0, count: 128); f[3] = 1
    for i in 0..<4 { idx.put("p\(i)", clip: nil, faces: [FaceFound(box: [0.1, 0.1, 0.2, 0.2], score: 0.9, emb: Vision.half(f))]) }
    let g = idx.cluster(threshold: 0.5, anchors: [("anna", ["p0:0"])], rejects: ["anna": ["p3:0"]], minFaces: 3)
    #expect(g.count == 1 && g[0].person == "anna" && g[0].items == ["p0", "p1", "p2"])
    // a face given to someone else ("move to") shows under them, even though it groups with Anna's
    let m = idx.cluster(threshold: 0.5, anchors: [("anna", ["p0:0"]), ("ben", ["p2:0"])], rejects: ["anna": ["p2:0"]], minFaces: 3)
    #expect(m.first { $0.person == "anna" }?.items == ["p0", "p1", "p3"])
    #expect(m.first { $0.person == "ben" }?.items == ["p2"])
  }

  @Test(.enabled(if: haveModels)) func visionRuns() throws {
    let v = try Vision(dir: models!, faces: true)
    // a plain test picture: a grey gradient (no faces)
    let w = 400, h = 300
    var px = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h { for x in 0..<w { let o = (y * w + x) * 4; px[o] = UInt8(x * 255 / w); px[o + 1] = UInt8(y * 255 / h); px[o + 2] = 128 } }
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let jpeg = Media.encodeJPEG(ctx.makeImage()!, quality: 0.9)!
    let a = try v.analyze(jpeg, faces: true)
    #expect(a.clip.count == 1024)
    #expect(a.faces?.isEmpty == true)
    let t = try Tokenizer(json: Data(contentsOf: models!.appendingPathComponent("mobileclip-s2-tokenizer.json")))
    let q = try v.textVector(t.encode("a colorful gradient"))
    #expect(q.count == 512)
    let img = Vision.unhalf(a.clip)
    var s: Float = 0
    for (x, y) in zip(img, q) { s += x * y }
    #expect(s > 0.05 && s < 1)
  }
}
