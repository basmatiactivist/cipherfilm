// One device indexes (docs/SEARCH.md, 1.9.0): who may write entries, what a reading device downloads, the model
// families the server keeps entries under, and the device name sent with every request.
import Foundation
import Testing
@testable import CipherfilmCore

private func me(_ session: String?, _ indexer: String?, id: String = "0123456789abcdef0123456789abcdef", demo: Bool? = nil) throws -> Me {
  var o: [String: Any] = ["user": ["id": id, "email": "a@b.c", "role": "user"], "csrf": "x", "kdf": ["alg": "argon2id", "v": 19, "salt": "", "ops": 3, "mem": 65536],
                          "wrapped_master_pw": "", "wrapped_privkey": "", "pubkey": ""]
  if let session { o["session_id"] = session }
  if let indexer { o["indexer"] = indexer }
  if let demo { o["demo"] = demo }
  return try JSONDecoder().decode(Me.self, from: JSONSerialization.data(withJSONObject: o))
}

@Suite struct IndexerTests {
  @Test func mayIndex() throws {
    #expect(try me("a", "").mayIndex)      // none yet: the first that writes becomes it
    #expect(try me("a", "a").mayIndex)
    #expect(try !me("a", "b").mayIndex)
    #expect(try me(nil, nil).mayIndex)     // a server before 1.9.0
  }

  /** The public demo login (DEMO_ACCOUNTS): only a server that says so makes one. */
  @Test func demo() throws {
    #expect(try me(nil, nil, demo: true).isDemo)
    #expect(try !me(nil, nil).isDemo)
    #expect(try !me(nil, nil, demo: false).isDemo)
  }

  /** The account id names folders on this Mac: anything but 32 lowercase hex is refused when /api/me is read. */
  @Test func accountIdShape() {
    for bad in ["../../../../Movies", "u", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcdef/", ""] {
      #expect(throws: DecodingError.self) { try me(nil, nil, id: bad) }
    }
    #expect(ServerId.valid("0123456789abcdef0123456789abcdef") && !ServerId.valid("0123456789abcdef0123456789abcde"))
  }

  @Test func readerDownloadsTextOnly() {
    #expect(Models.needed(faces: true, clip: .clip, reader: true).map(\.name) == ["clip-b32-text.onnx", "clip-b32-tokenizer.json"])
    #expect(Models.needed(faces: true).map(\.name) == ["clip-b32-vision.onnx", "clip-b32-text.onnx", "clip-b32-tokenizer.json", "yunet-2023mar.onnx", "sface-2021dec.onnx"])
    #expect(ClipModel.clip.family == "laionb32")
    // the family is the tag up to "+" or "/", as the server cuts it
    #expect(ClipModel.clip.tag.hasPrefix(ClipModel.clip.family + "+") && ClipModel.clip.tagNoFaces.hasPrefix(ClipModel.clip.family + "/"))
  }

  /** A reading Mac counts the photos still waiting for the indexing device, the same ones that device would index:
   *  not those it can't (broken, no key, not a photo or video, no picture), not those with an up-to-date entry. */
  @Test func waitingForTheIndexingDevice() {
    func item(_ id: String, kind: Kind = .image, pic: Bool = true, broken: Bool = false, key: Bool = true) -> Item {
      Item(id: id, kind: kind, size: 1, segmentCount: 1, createdAt: 0, hasThumb: pic, hasPreview: false, favorite: false,
           trashedAt: nil, purgeAt: nil, meta: nil, itemKey: key ? Data(repeating: 1, count: 32) : nil, broken: broken)
    }
    let items = [item("a"), item("b"), item("c", kind: .video), item("d", kind: .other), item("e", pic: false), item("f", broken: true), item("g", key: false), item("h")]
    #expect(items.filter(Models.indexable).map(\.id) == ["a", "b", "c", "h"])
    let clip = ClipModel.clip
    let tags = ["a": clip.tag, "b": clip.tagNoFaces, "h": "mcs2+yunet23+sface21/1"]
    #expect(Models.waiting(items, tags: tags, faces: true) == 3)  // b without faces, c none, h the old model
    #expect(Models.waiting(items, tags: tags, faces: false) == 2) // b is enough without faces
    #expect(Models.waiting(items, tags: ["a": clip.tag, "b": clip.tag, "c": clip.tag, "h": clip.tag], faces: true) == 0)
  }

  /** Becoming a reader deletes the image and face models and the yes to download them; "Index on This Mac Instead"
   *  asks again for exactly those (the reason the autotest's takeover waited forever when it skipped the question). */
  @Test func takingOverAsksForTheImageModelsAgain() throws {
    let s = ModelStore(dir: FileManager.default.temporaryDirectory.appendingPathComponent("cf-takeover-\(UUID().uuidString)"))
    defer { s.delete() }
    s.agree(faces: true)
    #expect(s.unagreed(faces: true).isEmpty)
    s.removeIndexing()
    #expect(s.unagreed(faces: true, reader: true).isEmpty) // reading needs nothing new
    #expect(Set(s.unagreed(faces: true).map(\.name)) == Set(([ClipModel.clip.vision] + Models.faceFiles).map(\.name)))
    s.agree(faces: true, reader: false)
    #expect(s.unagreed(faces: true).isEmpty)
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
