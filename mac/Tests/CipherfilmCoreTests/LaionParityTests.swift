// The search model, LAION's ViT-B/32 (docs/SEARCH.md): the explicit-search choice in the people document, and the
// vectors the Mac computes against scripts/laion-reference.py (ONNX Runtime in Python with the documented
// preprocessing). The vector test runs with CF_MODELS (a folder with clip-b32-*.onnx) and CF_LAION_REF (the output).
import Foundation
import Testing
@testable import CipherfilmCore

private let env = ProcessInfo.processInfo.environment
private let refFile = env["CF_LAION_REF"]
private let haveLaion = env["CF_MODELS"].map { FileManager.default.fileExists(atPath: URL(fileURLWithPath: $0).appendingPathComponent(ClipModel.clip.vision.name).path) } ?? false

private func cosine(_ a: [Float], _ b: [Float]) -> Float {
  var s: Float = 0, x: Float = 0, y: Float = 0
  for i in 0..<min(a.count, b.count) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return s / max(1e-9, sqrt(x) * sqrt(y))
}

@Suite struct LaionParityTests {
  @Test func peopleDocKeepsTheChoice() throws {
    var d = PeopleDoc()
    #expect(String(decoding: try JSONEncoder().encode(d), as: UTF8.self).contains("explicit") == false)
    d.explicit = true
    let back = try JSONDecoder().decode(PeopleDoc.self, from: JSONEncoder().encode(d))
    #expect(back.explicit == true)
    // a document from a device that doesn't know the field
    #expect(try JSONDecoder().decode(PeopleDoc.self, from: Data(#"{"v":1,"people":[]}"#.utf8)).explicit == nil)
  }

  @Test(.enabled(if: haveLaion && refFile != nil)) func vectorsMatchPython() throws {
    struct Ref: Decodable { let ort: String; let images: [String: [Float]]; let texts: [String: [Float]] }
    let ref = try JSONDecoder().decode(Ref.self, from: Data(contentsOf: URL(fileURLWithPath: refFile!)))
    let vision = try Vision(dir: URL(fileURLWithPath: env["CF_MODELS"]!), faces: false, clip: .clip)
    #expect(!ref.images.isEmpty)
    for (path, want) in ref.images.sorted(by: { $0.key < $1.key }) {
      let got = Vision.unhalf(try vision.analyze(Data(contentsOf: URL(fileURLWithPath: path)), faces: false).clip)
      let c = cosine(got, want)
      print("laion image \((path as NSString).lastPathComponent): cosine \(c) (python ORT \(ref.ort))")
      #expect(c >= 0.99, "\(path)")
    }
    let tok = [
      "a dog": [49406, 320, 1929, 49407],
      "sunset over mountains": [49406, 3424, 962, 5873, 49407],
      "A photo of a DOG on the beach!": [49406, 320, 1125, 539, 320, 1929, 525, 518, 2117, 256, 49407],
    ]
    for (t, want) in ref.texts {
      let c = cosine(try vision.textVector(tok[t]!), want)
      print("laion text \"\(t)\": cosine \(c)")
      #expect(c >= 0.999, "\(t)")
    }
  }
}
