// Nothing is downloaded from Hugging Face before the person agreed (docs/MODELS.md): the gate in ModelStore.download,
// which every download goes through; the yes is kept on this Mac, covers exactly the files agreed to, and goes with
// the models when search is turned off. None of these tests touch the network.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct ModelConsentTests {
  private func store() -> ModelStore {
    ModelStore(dir: FileManager.default.temporaryDirectory.appendingPathComponent("cf-consent-\(UUID().uuidString)"))
  }

  @Test func noDownloadWithoutTheYes() async throws {
    let s = store(); defer { s.delete() }
    let progressed = Flag()
    await #expect(throws: NeedsConsent.self) { try await s.download(faces: true) { _ in progressed.set() } }
    await #expect(throws: NeedsConsent.self) { try await s.download(faces: false, clip: .clip, reader: true) { _ in progressed.set() } }
    #expect(!progressed.value)
    #expect(s.unagreed(faces: true).count == 5)
    let e = await #expect(throws: NeedsConsent.self) { try await s.download(faces: false, reader: true) { _ in } }
    #expect(e?.bytes == ClipModel.clip.text.size + Models.tokenizer.size)
  }

  @Test func theYesIsKeptAndCoversExactlyThoseFiles() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: false, now: Date(timeIntervalSince1970: 1_800_000_000))
    let again = ModelStore(dir: s.dir) // the app started again
    #expect(again.consent()?.at == Date(timeIntervalSince1970: 1_800_000_000))
    #expect(Set(again.consent()?.sha ?? []) == Set(Models.needed(faces: false).map(\.sha256)))
    #expect(again.unagreed(faces: false).isEmpty)
    // faces need other files: asked again
    #expect(Set(again.unagreed(faces: true).map(\.name)) == ["yunet-2023mar.onnx", "sface-2021dec.onnx"])
  }

  @Test func aModelUpdateAsksAgain() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: false, reader: true)
    var c = try #require(s.consent())
    c.sha = c.sha.map { $0 == ClipModel.clip.text.sha256 ? String(repeating: "0", count: 64) : $0 } // agreed to an older file
    let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
    try enc.encode(c).write(to: s.dir.appendingPathComponent("consent.json"))
    #expect(s.unagreed(faces: false, reader: true).map(\.name) == ["clip-b32-text.onnx"])
  }

  @Test func modelsFromBeforeTheQuestionNeedNoneAndAreDated() throws {
    let s = store(); defer { s.delete() }
    try FileManager.default.createDirectory(at: s.dir, withIntermediateDirectories: true)
    let when = Date(timeIntervalSince1970: 1_700_000_000)
    for m in Models.needed(faces: false, reader: true) {
      let f = s.dir.appendingPathComponent(m.name)
      try Data("x".utf8).write(to: f)
      try FileManager.default.setAttributes([.modificationDate: when], ofItemAtPath: f.path)
    }
    #expect(s.unagreed(faces: false, reader: true).isEmpty)
    let d = try #require(s.downloaded())
    #expect(d.at == when)
    #expect(d.bytes == ClipModel.clip.text.size + Models.tokenizer.size)
  }

  @Test func aFileWithTheWrongHashIsNoYes() async throws {
    let s = store(); defer { s.delete() }
    try FileManager.default.createDirectory(at: s.dir, withIntermediateDirectories: true)
    try Data("x".utf8).write(to: s.dir.appendingPathComponent(Models.tokenizer.name))
    await #expect(throws: NeedsConsent.self) { try await s.download(faces: false, reader: true) { _ in } }
  }

  @Test func turningOffWithdrawsIt() throws {
    let s = store()
    s.agree(faces: true)
    s.delete()
    #expect(s.consent() == nil)
    #expect(s.downloaded() == nil)
    #expect(s.unagreed(faces: true).count == 5)
  }

  @Test func aReaderAsksAgainForWhatWent() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: true)
    s.removeIndexing() // another device indexes now: the image and face models go
    #expect(s.unagreed(faces: false, reader: true).isEmpty)
    #expect(Set(s.unagreed(faces: true).map(\.name)) == ["clip-b32-vision.onnx", "yunet-2023mar.onnx", "sface-2021dec.onnx"])
  }

  // One model (docs/SEARCH.md): a yes to MobileCLIP's files doesn't cover the new model; explicit search's LAION files
  // already here are moved to the new names and count as agreed, only the new tokenizer is asked for.
  @Test func movingToOneModel() throws {
    let s = store(); defer { s.delete() }
    try FileManager.default.createDirectory(at: s.dir, withIntermediateDirectories: true)
    let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
    try enc.encode(ModelConsent(at: Date(), sha: ["d28b92d7a3a6ba99bd000cce5c91678c0e279dc934c887a3785908a811872a6c", "f8aaa97cf17fbadd78b0bd6d5f6a1c57f712402cacc3055ea92c1a3331357dfe", "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85"])).write(to: s.dir.appendingPathComponent("consent.json"))
    #expect(Set(s.unagreed(faces: false).map(\.name)) == ["clip-b32-vision.onnx", "clip-b32-text.onnx", "clip-b32-tokenizer.json"])
    for n in ["nsfw-laion-b32-vision.onnx", "nsfw-laion-b32-text.onnx", "mobileclip-s2-vision.onnx", "mobileclip-s2-text.onnx", "mobileclip-s2-tokenizer.json", "mobileclip-s2-vision.onnx.part"] {
      try Data(n.utf8).write(to: s.dir.appendingPathComponent(n))
    }
    let again = ModelStore(dir: s.dir) // the next start
    let here = Set(try FileManager.default.contentsOfDirectory(atPath: s.dir.path))
    #expect(here == ["consent.json", "clip-b32-vision.onnx", "clip-b32-text.onnx"])
    #expect(try String(contentsOf: s.dir.appendingPathComponent("clip-b32-text.onnx"), encoding: .utf8) == "nsfw-laion-b32-text.onnx") // moved, not fetched
    #expect(again.unagreed(faces: false).map(\.name) == ["clip-b32-tokenizer.json"])
  }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock(); private var v = false
  func set() { lock.withLock { v = true } }
  var value: Bool { lock.withLock { v } }
}
