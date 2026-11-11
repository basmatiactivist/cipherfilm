// Index entries the Android app wrote to the local test server (mobile/dev/compose.yaml) must be what the Mac computes
// for the same photo. Read-only: it signs in with the project's test account, opens the entries and compares.
//   CF_TEST_SERVER=https://127.0.0.1:8443 CF_TEST_CA=<caddy root.crt> CF_TEST_EMAIL=… CF_TEST_PASSWORD=… CF_MODELS=<dir>
import Foundation
import Testing
@testable import CipherfilmCore

private let env = ProcessInfo.processInfo.environment
private let enabled = env["CF_TEST_SERVER"] != nil && env["CF_TEST_PASSWORD"] != nil && env["CF_MODELS"] != nil

private func cosine(_ a: [Float], _ b: [Float]) -> Float {
  var s: Float = 0, x: Float = 0, y: Float = 0
  for i in 0..<min(a.count, b.count) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return s / max(1e-9, sqrt(x) * sqrt(y))
}

@Suite struct AndroidParityTests {
  @Test(.enabled(if: enabled)) func entriesMatchAndroid() async throws {
    let api = API(base: try API.origin(env["CF_TEST_SERVER"]!))
    guard case .done(let me, let master) = try await Account.login(api: api, email: env["CF_TEST_EMAIL"] ?? "tester@example.org", password: env["CF_TEST_PASSWORD"]!) else {
      Issue.record("the test account has two-step sign-in on"); return
    }
    let vault = Vault(api: api, me: me, masterKey: master)
    let items = try await vault.loadLibrary()
    struct Page: Decodable { struct E: Decodable { let item_id: String; let data_enc: String }; let entries: [E]; let next: String? }
    let page = try await api.get(Page.self, "/api/index?since=0")
    let pair = try vault.pair()
    let vision = try Vision(dir: URL(fileURLWithPath: env["CF_MODELS"]!), faces: true)
    var compared = 0, faceMatches = 0, faceCount = 0
    var worst: Float = 1
    for e in page.entries.prefix(40) {
      guard let it = items.first(where: { $0.id == e.item_id }), !it.broken else { continue }
      let theirs = try IndexEntry.open(B64.decode(e.data_enc), pair: pair, itemId: it.id)
      guard theirs.m == Models.tag, let tc = theirs.clip else { continue }
      let mine = try vision.analyze(try await vault.bestPicture(of: it), faces: true)
      let c = cosine(Vision.unhalf(try B64.decode(tc)), Vision.unhalf(mine.clip))
      worst = min(worst, c)
      compared += 1
      print("parity \(it.id.prefix(8)) \(it.kind) clip cosine \(c) faces android \(theirs.faces?.count ?? 0) mac \(mine.faces?.count ?? 0)")
      for f in theirs.faces ?? [] {
        faceCount += 1
        let fe = Vision.unhalf(try B64.decode(f.emb))
        if let best = mine.faces?.max(by: { cosine(Vision.unhalf($0.emb), fe) < cosine(Vision.unhalf($1.emb), fe) }) {
          let fc = cosine(Vision.unhalf(best.emb), fe)
          print("  face android \(f.box) \(f.score) mac \(best.box) \(best.score) cosine \(fc)")
          if fc > 0.9 { faceMatches += 1 }
        }
      }
    }
    print("parity: \(compared) entries, worst clip cosine \(worst), faces matched \(faceMatches)/\(faceCount)")
    #expect(compared > 0)
    #expect(worst > 0.97)
    #expect(faceMatches == faceCount)
  }
}
