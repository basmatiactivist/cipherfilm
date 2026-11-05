// One device indexes (docs/SEARCH.md, 1.9.0): who may write entries, what a reading device downloads, the model
// families the server keeps entries under, and the device name sent with every request.
import Foundation
import Testing
@testable import CipherfilmCore

private func me(_ session: String?, _ indexer: String?) throws -> Me {
  var o: [String: Any] = ["user": ["id": "u", "email": "a@b.c", "role": "user"], "csrf": "x", "kdf": ["alg": "argon2id", "v": 19, "salt": "", "ops": 3, "mem": 65536],
                          "wrapped_master_pw": "", "wrapped_privkey": "", "pubkey": ""]
  if let session { o["session_id"] = session }
  if let indexer { o["indexer"] = indexer }
  return try JSONDecoder().decode(Me.self, from: JSONSerialization.data(withJSONObject: o))
}

@Suite struct IndexerTests {
  @Test func mayIndex() throws {
    #expect(try me("a", "").mayIndex)      // none yet: the first that writes becomes it
    #expect(try me("a", "a").mayIndex)
    #expect(try !me("a", "b").mayIndex)
    #expect(try me(nil, nil).mayIndex)     // a server before 1.9.0
  }

  @Test func readerDownloadsTextOnly() {
    #expect(Models.needed(faces: true, clip: .mobileclip, reader: true).map(\.name) == ["mobileclip-s2-text.onnx", "mobileclip-s2-tokenizer.json"])
    #expect(Models.needed(faces: true, clip: .laion, reader: true).map(\.name) == ["nsfw-laion-b32-text.onnx", "mobileclip-s2-tokenizer.json"])
    #expect(ClipModel.mobileclip.family == "mcs2" && ClipModel.laion.family == "laionb32")
    // the family is the tag up to "+" or "/", as the server cuts it
    #expect(ClipModel.laion.tag.hasPrefix(ClipModel.laion.family + "+") && ClipModel.mobileclip.tagNoFaces.hasPrefix(ClipModel.mobileclip.family + "/"))
  }

  @Test func deviceName() {
    #expect(API.device.hasSuffix("(Mac app)"))
    // a header value must be ASCII, or the request fails before it is sent
    #expect(API.device.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value < 0x7f })
  }
}

private let env = ProcessInfo.processInfo.environment

/** Against the local test server: the device list shows the name this Mac sent at sign-in. */
@Suite struct DeviceListTests {
  @Test(.enabled(if: env["CF_TEST_SERVER"] != nil && env["CF_TEST_PASSWORD"] != nil)) func namedAtSignIn() async throws {
    let api = API(base: try API.origin(env["CF_TEST_SERVER"]!), cookies: HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: "cftest-device-name"))
    _ = try await Account.login(api: api, email: env["CF_TEST_EMAIL"] ?? "tester@example.org", password: env["CF_TEST_PASSWORD"]!)
    struct S: Decodable { struct E: Decodable { let device: String; let current: Bool }; let sessions: [E] }
    let list = try await api.get(S.self, "/api/me/sessions")
    #expect(list.sessions.first { $0.current }?.device == API.device)
    _ = try? await api.json("POST", "/api/auth/logout")
  }
}

/** A slow or dropped connection is not "Can't connect": each cause has its own words. */
@Suite struct NetworkMessageTests {
  @Test func causes() {
    #expect(API.network(URLError(.timedOut)).contains("slow"))
    #expect(API.network(URLError(.networkConnectionLost)).contains("dropped"))
    #expect(API.network(URLError(.notConnectedToInternet)).contains("offline"))
    #expect(API.network(URLError(.cannotConnectToHost)).contains("isn't answering"))
    #expect(Set([URLError.Code.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost].map { API.network(URLError($0)) }).count == 4)
  }
}
