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
    await #expect(throws: NeedsConsent.self) { try await s.download(faces: false, clip: .laion, reader: true) { _ in progressed.set() } }
    #expect(!progressed.value)
    #expect(s.unagreed(faces: true).count == 5)
    let e = await #expect(throws: NeedsConsent.self) { try await s.download(faces: false, reader: true) { _ in } }
    #expect(e?.bytes == ClipModel.mobileclip.text.size + Models.tokenizer.size)
  }

  @Test func theYesIsKeptAndCoversExactlyThoseFiles() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: false, now: Date(timeIntervalSince1970: 1_800_000_000))
    let again = ModelStore(dir: s.dir) // the app started again
    #expect(again.consent()?.at == Date(timeIntervalSince1970: 1_800_000_000))
    #expect(Set(again.consent()?.sha ?? []) == Set(Models.needed(faces: false).map(\.sha256)))
    #expect(again.unagreed(faces: false).isEmpty)
    // faces and explicit search need other files: asked again
    #expect(Set(again.unagreed(faces: true).map(\.name)) == ["yunet-2023mar.onnx", "sface-2021dec.onnx"])
    #expect(Set(again.unagreed(faces: false, clip: .laion).map(\.name)) == ["nsfw-laion-b32-vision.onnx", "nsfw-laion-b32-text.onnx"])
  }

  @Test func aModelUpdateAsksAgain() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: false, reader: true)
    var c = try #require(s.consent())
    c.sha = c.sha.map { $0 == ClipModel.mobileclip.text.sha256 ? String(repeating: "0", count: 64) : $0 } // agreed to an older file
    let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
    try enc.encode(c).write(to: s.dir.appendingPathComponent("consent.json"))
    #expect(s.unagreed(faces: false, reader: true).map(\.name) == ["mobileclip-s2-text.onnx"])
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
    #expect(d.bytes == ClipModel.mobileclip.text.size + Models.tokenizer.size)
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

  @Test func switchingModelsAsksAgainForWhatWent() throws {
    let s = store(); defer { s.delete() }
    s.agree(faces: false, clip: .laion, reader: true)
    s.agree(faces: false, reader: true)
    s.removeUnused(clip: .mobileclip, reader: true) // back to standard search: LAION's files go
    #expect(Set(s.unagreed(faces: false, clip: .laion, reader: true).map(\.name)) == ["nsfw-laion-b32-text.onnx"])
    #expect(s.unagreed(faces: false, reader: true).isEmpty)
  }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock(); private var v = false
  func set() { lock.withLock { v = true } }
  var value: Bool { lock.withLock { v } }
}
