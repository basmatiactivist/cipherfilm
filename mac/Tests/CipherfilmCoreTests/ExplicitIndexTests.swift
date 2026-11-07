// Explicit search on (docs/SEARCH.md): the indexing device keeps MobileCLIP's entries current next to LAION's, so the
// devices that can't use explicit search (the Android app from Google Play, an older app, a person not allowed) always
// find a complete index. Turning it on deletes nothing; turning it off deletes LAION's entries.
import CoreGraphics
import Foundation
import Testing
@testable import CipherfilmCore

private let modelDir = ProcessInfo.processInfo.environment["CF_MODELS"].map { URL(fileURLWithPath: $0) }
private let haveBoth = modelDir.map { d in (Models.needed(faces: true, clip: .laion) + [ClipModel.mobileclip.text]).allSatisfy { FileManager.default.fileExists(atPath: d.appendingPathComponent($0.name).path) } } ?? false

@Suite struct ExplicitIndexTests {
  @Test func switchingNeverDropsMobileCLIP() {
    #expect(ClipModel.dropped(from: .mobileclip, to: .laion) == nil)
    #expect(ClipModel.dropped(from: .laion, to: .mobileclip) == .laion)
    #expect(ClipModel.dropped(from: .laion, to: .laion) == nil && ClipModel.dropped(from: .mobileclip, to: .mobileclip) == nil)
  }

  @Test func indexingWithLaionNeedsMobileCLIPsImageModel() {
    #expect(ClipModel.laion.keepsStandard(indexes: true) && !ClipModel.laion.keepsStandard(indexes: false) && !ClipModel.mobileclip.keepsStandard(indexes: true))
    #expect(Models.needed(faces: true, clip: .laion).map(\.name).sorted() == ["mobileclip-s2-tokenizer.json", "mobileclip-s2-vision.onnx", "nsfw-laion-b32-text.onnx", "nsfw-laion-b32-vision.onnx", "sface-2021dec.onnx", "yunet-2023mar.onnx"])
    #expect(!Models.needed(faces: true, clip: .laion, reader: true).contains { $0.name == "mobileclip-s2-vision.onnx" })
    #expect(Models.needed(faces: true, clip: .mobileclip).map(\.name) == Models.all(.mobileclip).map(\.name))
  }

  @Test func eachPhotoIsDoneOnlyWithBothEntries() {
    let L = ClipModel.laion.tag, M = ClipModel.mobileclip.tag
    #expect(Models.toCompute(L, standard: M, faces: true, clip: .laion) == [])
    #expect(Models.toCompute(nil, standard: nil, faces: true, clip: .laion) == [.laion, .mobileclip])
    // MobileCLIP's deleted by an older app when explicit search was turned on: only it is made again
    #expect(Models.toCompute(L, standard: nil, faces: true, clip: .laion) == [.mobileclip])
    #expect(Models.toCompute(nil, standard: M, faces: true, clip: .laion) == [.laion])
    #expect(Models.toCompute(L, standard: ClipModel.mobileclip.tagNoFaces, faces: true, clip: .laion) == [.mobileclip])
    #expect(Models.toCompute(L, standard: ClipModel.mobileclip.tagNoFaces, faces: false, clip: .laion) == [])
    // standard search, or a device that only reads: one model, as before
    #expect(Models.toCompute(nil, standard: nil, faces: true, clip: .mobileclip) == [.mobileclip])
    #expect(Models.toCompute(L, standard: nil, faces: true, clip: .laion, indexes: false) == [])
  }

  @Test func oneLookMakesBothEntriesWithTheSameFaces() throws {
    let face = FaceFound(box: [0.1, 0.2, 0.3, 0.4], score: 0.95, emb: Data([1, 2, 3, 4]))
    let a = Analyses(clips: [(.laion, Data([1, 0])), (.mobileclip, Data([2, 0]))], faces: [face])
    let es = IndexEntry.entries(a, faces: true)
    #expect(es.map(\.m) == [ClipModel.laion.tag, ClipModel.mobileclip.tag])
    #expect(es[0].clip != es[1].clip)
    #expect(es[0].faces?.map(\.emb) == es[1].faces?.map(\.emb) && es[0].faces?.count == 1)
    // faces off: neither has any
    #expect(IndexEntry.entries(a, faces: false).map(\.m) == [ClipModel.laion.tagNoFaces, ClipModel.mobileclip.tagNoFaces])
    #expect(IndexEntry.entries(a, faces: false).allSatisfy { $0.faces == nil })
    // only MobileCLIP's missing: the faces come from LAION's entry, not from looking again
    let known = [IndexEntry.Face(box: [0.5, 0.5, 0.1, 0.1], score: 0.9, emb: "AAAA")]
    let one = IndexEntry.entries(Analyses(clips: [(.mobileclip, Data([3, 0]))], faces: nil), faces: true, known: known)
    #expect(one.count == 1 && one[0].m == ClipModel.mobileclip.tag && one[0].faces?.map(\.emb) == ["AAAA"])
    // sealed and opened like any other entry
    let kp = Sodium.boxKeypair()
    let id = "0123456789abcdef0123456789abcdef"
    let back = try IndexEntry.open(try es[1].seal(pk: kp.pk, itemId: id), pair: KeyPair(pk: kp.pk, sk: kp.sk), itemId: id)
    #expect(back.m == ClipModel.mobileclip.tag && back.faces?.count == 1)
  }

  @Test func switchingKeepsMobileCLIPsImageModelOnTheIndexer() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-explicit-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let all = [ClipModel.mobileclip, .laion].flatMap { [$0.vision, $0.text] } + [Models.tokenizer] + Models.faceFiles
    func fill() { for m in all { FileManager.default.createFile(atPath: dir.appendingPathComponent(m.name).path, contents: Data([0])) } }
    func left() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted() }
    let store = ModelStore(dir: dir)
    fill()
    #expect(store.removeUnused(clip: .laion, reader: false) == ["mobileclip-s2-text.onnx"])
    #expect(left().contains("mobileclip-s2-vision.onnx"))
    fill()
    #expect(store.removeUnused(clip: .mobileclip, reader: false).sorted() == ["nsfw-laion-b32-text.onnx", "nsfw-laion-b32-vision.onnx"])
    fill()
    #expect(store.removeUnused(clip: .laion, reader: true).sorted() == ["mobileclip-s2-text.onnx", "mobileclip-s2-vision.onnx", "nsfw-laion-b32-vision.onnx"])
  }

  /** With the models (CF_MODELS): one look with both image models gives each model's own vector, as either alone does. */
  @Test(.enabled(if: haveBoth)) func bothModelsFromOneLook() throws {
    let w = 400, h = 300
    var px = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h { for x in 0..<w { let o = (y * w + x) * 4; px[o] = UInt8(x * 255 / w); px[o + 1] = UInt8(y * 255 / h); px[o + 2] = 128 } }
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let jpeg = Media.encodeJPEG(ctx.makeImage()!, quality: 0.9)!
    let both = try Vision(dir: modelDir!, faces: true, clip: .laion, standardToo: true).analyze(jpeg, faces: true, clips: [.laion, .mobileclip])
    #expect(both.clips.map(\.model) == [.laion, .mobileclip])
    #expect(both.clips[0].vector == (try Vision(dir: modelDir!, faces: true, clip: .laion).analyze(jpeg, faces: true).clip))
    #expect(both.clips[1].vector == (try Vision(dir: modelDir!, faces: true, clip: .mobileclip).analyze(jpeg, faces: true).clip))
    // without MobileCLIP's image model opened, it isn't run
    #expect(throws: CryptoError.self) { try Vision(dir: modelDir!, faces: false, clip: .laion).analyze(jpeg, faces: false, clips: [.mobileclip]) }
  }
}
