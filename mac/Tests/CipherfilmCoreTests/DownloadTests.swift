// The model download against the local test server: a whole file, then one cut in the middle and resumed with Range.
//   CF_TEST_SERVER=https://localhost:8443 CF_TEST_CA=<caddy root.crt> CF_TEST_PASSWORD=… ./scripts/test.sh --filter Download
import Foundation
import Testing
@testable import CipherfilmCore

private let env = ProcessInfo.processInfo.environment
private let enabled = env["CF_TEST_SERVER"] != nil && env["CF_TEST_PASSWORD"] != nil

@Suite struct DownloadTests {
  @Test(.enabled(if: enabled)) func resumesWithRange() async throws {
    let api = API(base: try API.origin(env["CF_TEST_SERVER"]!))
    _ = try await Account.login(api: api, email: env["CF_TEST_EMAIL"] ?? "tester@example.org", password: env["CF_TEST_PASSWORD"]!)
    let m = Models.faceFiles[1] // sface, 38 MB
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("cf-dl-test-\(UUID().uuidString).part")
    defer { try? FileManager.default.removeItem(at: file) }
    try await api.download("/api/models/\(m.name)", to: file, expected: m.size) { _ in }
    #expect(Models.sha256(of: file) == m.sha256)
    // keep the first third, as a drop would, and fetch the rest
    let fh = try FileHandle(forWritingTo: file)
    try fh.truncate(atOffset: UInt64(m.size / 3)); try fh.close()
    let first = Box()
    try await api.download("/api/models/\(m.name)", to: file, expected: m.size) { e in if case .bytes(let n) = e { first.set(n) } }
    #expect(first.value == m.size / 3, "resumed at the third, not from the start")
    #expect(Models.sha256(of: file) == m.sha256)
  }
}

private final class Box: @unchecked Sendable {
  private let lock = NSLock(); private var v: Int64?
  func set(_ n: Int64) { lock.withLock { if v == nil { v = n } } }
  var value: Int64? { lock.withLock { v } }
}
