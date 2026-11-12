// The search models: the Mac's list must be the shared one (server/models.json), and the download from Hugging Face
// resumes with Range. The download test needs the network (38 MB):
//   CF_TEST_NETWORK=1 ./scripts/test.sh --filter Download
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private struct Listed: Decodable { let name: String; let url: String; let sha256: String; let size: Int64 }

@Suite struct DownloadTests {
  @Test func sameListAsTheServerAndTheOtherApps() throws {
    let listed = try JSONDecoder().decode([Listed].self, from: Data(contentsOf: repo.appendingPathComponent("server/models.json")))
    let mine = Models.every
    #expect(Set(mine.map(\.name)) == Set(listed.map(\.name)))
    for m in mine {
      let l = listed.first { $0.name == m.name }
      #expect(l?.url == m.url.absoluteString && l?.sha256 == m.sha256 && l?.size == m.size, "\(m.name)")
    }
    #expect(!mine.contains { $0.url.absoluteString.lowercased().contains("mobileclip") })
  }

  @Test(.enabled(if: ProcessInfo.processInfo.environment["CF_TEST_NETWORK"] != nil)) func resumesWithRange() async throws {
    let m = Models.faceFiles[1] // sface, 38 MB
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("cf-dl-test-\(UUID().uuidString).part")
    defer { try? FileManager.default.removeItem(at: file) }
    try await API.download(m.url, to: file, expected: m.size) { _ in }
    #expect(Models.sha256(of: file) == m.sha256)
    // keep the first third, as a drop would, and fetch the rest
    let fh = try FileHandle(forWritingTo: file)
    try fh.truncate(atOffset: UInt64(m.size / 3)); try fh.close()
    let first = Box()
    try await API.download(m.url, to: file, expected: m.size) { e in if case .bytes(let n) = e { first.set(n) } }
    #expect(first.value == m.size / 3, "resumed at the third, not from the start")
    #expect(Models.sha256(of: file) == m.sha256)
  }

  @Test func onlyHTTPS() async {
    await #expect(throws: APIError.self) {
      try await API.download(URL(string: "http://huggingface.co/x")!, to: FileManager.default.temporaryDirectory.appendingPathComponent("cf-x"), expected: 1) { _ in }
    }
  }
}

private final class Box: @unchecked Sendable {
  private let lock = NSLock(); private var v: Int64?
  func set(_ n: Int64) { lock.withLock { if v == nil { v = n } } }
  var value: Int64? { lock.withLock { v } }
}
