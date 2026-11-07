// Search and people on the Mac: the models (downloaded from Hugging Face at pinned URLs, checked against fixed SHA-256
// values; the same list as server/models.json, which a test compares), index entries in the shared format (docs/SEARCH.md), the people document, and the search box's query
// language. The same constants as mobile/src/search/*.ts, so an entry made here is used on the phone and back.
import CryptoKit
import Foundation

public struct ModelFile: Sendable {
  public let name: String; public let url: URL; public let sha256: String; public let size: Int64; public let faces: Bool
  /** url: the file's pinned Hugging Face URL (a commit, not a branch), as in server/models.json */
  init(name: String, url: String, sha256: String, size: Int64, faces: Bool) {
    self.name = name; self.url = URL(string: url)!; self.sha256 = sha256; self.size = size; self.faces = faces
  }
}

/** Which model says what is in a photo. MobileCLIP S2 for everyone; LAION's OpenCLIP ViT-B/32 for a person an admin
 *  allowed explicit search and who turned it on (docs/SEARCH.md, "Explicit search"). Both use the same tokenizer. */
public enum ClipModel: String, Sendable, Codable {
  case mobileclip = "mobileclip-s2"
  case laion = "laion-b32"

  public static func choose(allowed: Bool, explicit: Bool) -> ClipModel { allowed && explicit ? .laion : .mobileclip }

  public var vision: ModelFile {
    switch self {
    case .mobileclip: ModelFile(name: "mobileclip-s2-vision.onnx", url: "https://huggingface.co/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/onnx/vision_model.onnx", sha256: "d28b92d7a3a6ba99bd000cce5c91678c0e279dc934c887a3785908a811872a6c", size: 143_020_962, faces: false)
    case .laion: ModelFile(name: "nsfw-laion-b32-vision.onnx", url: "https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/visual/model.onnx", sha256: "b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c", size: 351_613_724, faces: false)
    }
  }

  public var text: ModelFile {
    switch self {
    case .mobileclip: ModelFile(name: "mobileclip-s2-text.onnx", url: "https://huggingface.co/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/onnx/text_model_quantized.onnx", sha256: "f8aaa97cf17fbadd78b0bd6d5f6a1c57f712402cacc3055ea92c1a3331357dfe", size: 64_117_260, faces: false)
    case .laion: ModelFile(name: "nsfw-laion-b32-text.onnx", url: "https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/textual/model.onnx", sha256: "48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722", size: 254_193_396, faces: false)
    }
  }

  /** Index entry tags: bumped when the models or how their output is used change, entries with another are made again. */
  public var tag: String { self == .mobileclip ? "mcs2+yunet23+sface21/2" : "laionb32+yunet23+sface21/1" }
  public var tagNoFaces: String { self == .mobileclip ? "mcs2/2" : "laionb32/1" }

  /** The model family the server keeps entries under (`GET /api/index?model=`): the tag up to "+" or "/". */
  public var family: String { self == .mobileclip ? "mcs2" : "laionb32" }

  /** Whether an entry's tag was made with this model (its image vector can be compared with this model's). */
  public func owns(_ tag: String?) -> Bool { tag == self.tag || tag == tagNoFaces }

  /** The model every device can search with: the Android app from Google Play, an older app, a person not allowed. */
  public static let standard = ClipModel.mobileclip

  /** While explicit search is on, the indexing device keeps MobileCLIP's entries current too (docs/SEARCH.md,
   *  "Explicit search"), so the devices that only read those always find a complete index. */
  public func keepsStandard(indexes: Bool) -> Bool { indexes && self != .standard }

  /** The family whose entries go on the server when the account's model changes: LAION's when explicit search is
   *  turned off (they free space); MobileCLIP's never, other devices search with them. */
  public static func dropped(from old: ClipModel, to new: ClipModel) -> ClipModel? { old == .laion && new != .laion ? .laion : nil }
}

public enum Models {
  public static let tokenizer = ModelFile(name: "mobileclip-s2-tokenizer.json", url: "https://huggingface.co/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/tokenizer.json", sha256: "72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85", size: 2_224_081, faces: false)
  public static let faceFiles: [ModelFile] = [
    ModelFile(name: "yunet-2023mar.onnx", url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", size: 232_589, faces: true),
    ModelFile(name: "sface-2021dec.onnx", url: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx", sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79", size: 38_696_353, faces: true),
  ]

  public static func all(_ clip: ClipModel) -> [ModelFile] { [clip.vision, clip.text, tokenizer] + faceFiles }

  /** MobileCLIP's tags, kept for callers and tests that predate the choice of model. */
  public static let tag = ClipModel.mobileclip.tag
  public static let tagNoFaces = ClipModel.mobileclip.tagNoFaces

  /** Whether an entry is up to date: made with this model, and with faces when faces are wanted. */
  public static func good(_ tag: String?, faces: Bool, clip: ClipModel = .mobileclip) -> Bool { faces ? tag == clip.tag : clip.owns(tag) }

  /** reader: a device that only reads the index (another one computes it) needs just the text model and the tokenizer.
   *  Indexing with LAION also needs MobileCLIP's image model (not its text model: this device searches with LAION). */
  public static func needed(faces: Bool, clip: ClipModel = .mobileclip, reader: Bool = false) -> [ModelFile] {
    if reader { return [clip.text, tokenizer] }
    let also = clip.keepsStandard(indexes: true) ? [ClipModel.standard.vision] : []
    return (all(clip) + also).filter { faces || !$0.faces }
  }

  /** What the indexing device still computes for a photo, from the tags of its entries (the account's model's and,
   *  next to LAION, MobileCLIP's): the models whose entry isn't current. Empty when the photo is done. */
  public static func toCompute(_ tag: String?, standard: String?, faces: Bool, clip: ClipModel, indexes: Bool = true) -> [ClipModel] {
    var out = good(tag, faces: faces, clip: clip) ? [] : [clip]
    if clip.keepsStandard(indexes: indexes) && !good(standard, faces: faces, clip: .standard) { out.append(.standard) }
    return out
  }

  public static func sha256(of url: URL) -> String? {
    guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? fh.close() }
    var h = SHA256()
    while let d = try? fh.read(upToCount: 4 << 20), !d.isEmpty { h.update(data: d) }
    return h.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

/** Where the models live and whether they are there; a file is checked once per start. */
public final class ModelStore: @unchecked Sendable {
  public let dir: URL
  private let lock = NSLock()
  private var checked = Set<String>()

  public init(dir: URL) { self.dir = dir }

  public func missingBytes(faces: Bool, clip: ClipModel = .mobileclip, reader: Bool = false) -> Int64 {
    Models.needed(faces: faces, clip: clip, reader: reader).filter { !FileManager.default.fileExists(atPath: dir.appendingPathComponent($0.name).path) }.reduce(0) { $0 + $1.size }
  }

  public func have(faces: Bool, clip: ClipModel = .mobileclip, reader: Bool = false) -> Bool {
    for m in Models.needed(faces: faces, clip: clip, reader: reader) {
      if lock.withLock({ checked.contains(m.name) }) { continue }
      let f = dir.appendingPathComponent(m.name)
      guard FileManager.default.fileExists(atPath: f.path) else { return false }
      guard Models.sha256(of: f) == m.sha256 else { try? FileManager.default.removeItem(at: f); return false }
      lock.withLock { _ = checked.insert(m.name) }
    }
    return true
  }

  public struct Progress: Sendable {
    public var done: Int64
    public var total: Int64
    /** set while waiting to try again after a drop: the reason and the seconds until the next try */
    public var retry: (reason: String, seconds: Int)?
  }

  /** Downloads what is missing from Hugging Face, each file into "<name>.part" next to where it goes, so a drop (or a
   *  quit) resumes where it stopped; progress counts the bytes of all files together. */
  public func download(faces: Bool, clip: ClipModel = .mobileclip, reader: Bool = false, progress: @escaping @Sendable (Progress) -> Void) async throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let list = Models.needed(faces: faces, clip: clip, reader: reader).filter { m in !lock.withLock { checked.contains(m.name) } && !(FileManager.default.fileExists(atPath: dir.appendingPathComponent(m.name).path) && Models.sha256(of: dir.appendingPathComponent(m.name)) == m.sha256) }
    let total = list.reduce(Int64(0)) { $0 + $1.size }
    var before: Int64 = 0
    for m in list {
      let b = before
      let part = dir.appendingPathComponent(m.name + ".part")
      try await API.download(m.url, to: part, expected: m.size) { e in
        switch e {
        case .bytes(let n): progress(Progress(done: b + n, total: total))
        case .retrying(let s, let reason):
          let n = (try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? NSNumber)?.int64Value ?? 0
          progress(Progress(done: b + n, total: total, retry: (reason, s)))
        }
      }
      guard Models.sha256(of: part) == m.sha256 else {
        try? FileManager.default.removeItem(at: part)
        throw CryptoError.failed("A search model didn't match its checksum and was not used.")
      }
      let dest = dir.appendingPathComponent(m.name)
      try? FileManager.default.removeItem(at: dest)
      try FileManager.default.moveItem(at: part, to: dest)
      lock.withLock { _ = checked.insert(m.name) }
      before += m.size
      progress(Progress(done: before, total: total))
    }
  }

  /** Removes the files of a model no longer used (the explicit model's 600 MB after it is turned off). */
  public func remove(_ clip: ClipModel) { remove([clip.vision, clip.text]) }

  /** Removes the image and text models that using `clip` doesn't need (MobileCLIP's text model next to LAION; its
   *  image model too where this device only reads). Returns their names. */
  @discardableResult
  public func removeUnused(clip: ClipModel, reader: Bool) -> [String] {
    let keep = Set(Models.needed(faces: true, clip: clip, reader: reader).map(\.name))
    let gone = [ClipModel.mobileclip, .laion].flatMap { [$0.vision, $0.text] }.filter { !keep.contains($0.name) }
    remove(gone)
    return gone.map(\.name)
  }

  /** A device that only reads the index keeps no image or face models (hundreds of MB it would never run). */
  public func removeIndexing() { remove([ClipModel.mobileclip.vision, ClipModel.laion.vision] + Models.faceFiles) }

  private func remove(_ files: [ModelFile]) {
    for m in files {
      lock.withLock { _ = checked.remove(m.name) }
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(m.name))
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(m.name + ".part"))
    }
  }

  public func delete() {
    lock.withLock { checked = [] }
    try? FileManager.default.removeItem(at: dir)
  }
}

// ---- index entries ----

public struct IndexEntry: Codable, Sendable {
  public struct Face: Codable, Sendable { public var box: [Double]; public var score: Double; public var emb: String }
  public var v: Int
  public var m: String
  public var clip: String?
  public var faces: [Face]?

  public init(analysis a: Analysis, faces: Bool, model: ClipModel = .mobileclip) {
    self.init(vector: a.clip, faces: faces ? Self.faces(a.faces) : nil, model: model)
  }

  /** faces: nil where faces are off */
  public init(vector: Data, faces: [Face]?, model: ClipModel) {
    v = 1
    m = faces != nil ? model.tag : model.tagNoFaces
    clip = B64.encode(vector)
    self.faces = faces
  }

  static func faces(_ found: [FaceFound]?) -> [Face] { (found ?? []).map { Face(box: $0.box, score: $0.score, emb: B64.encode($0.emb)) } }

  /** The entries for one look at a photo, one per model in a.clips; the faces found once go into each, or those given
   *  (known: from the photo's other entry, when only one was missing), so both list the same faces. */
  public static func entries(_ a: Analyses, faces: Bool, known: [Face]? = nil) -> [IndexEntry] {
    let fs = faces ? known ?? Self.faces(a.faces) : nil
    return a.clips.map { IndexEntry(vector: $0.vector, faces: fs, model: $0.model) }
  }

  public func seal(pk: Data, itemId: String) throws -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    return try Crypto.sealIndexEntry(enc.encode(self), pk: pk, itemId: itemId)
  }

  public static func open(_ blob: Data, pair: KeyPair, itemId: String) throws -> IndexEntry {
    let e = try JSONDecoder().decode(IndexEntry.self, from: Crypto.openIndexEntry(blob, pair: pair, itemId: itemId))
    guard e.v == 1 else { throw CryptoError.failed("unknown index version") }
    return e
  }

  /** The vectors, for the in-memory index. */
  public func decoded(faces want: Bool) -> (clip: Data?, faces: [FaceFound]) {
    let c = clip.flatMap { try? B64.decode($0) }
    let fs = want ? (faces ?? []).compactMap { f -> FaceFound? in
      guard let e = try? B64.decode(f.emb) else { return nil }
      return FaceFound(box: f.box, score: f.score, emb: e.prefix(Vision.faceDim * 2))
    } : []
    return (c, fs)
  }
}

// ---- the people document (names and decisions), shared by the person's devices ----

public struct Person: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var name: String
  public var hidden: Bool?
  public var anchors: [String]
  public var rejects: [String]
  public init(id: String, name: String, hidden: Bool?, anchors: [String], rejects: [String]) {
    self.id = id; self.name = name; self.hidden = hidden; self.anchors = anchors; self.rejects = rejects
  }
}

public struct PeopleDoc: Codable, Sendable {
  public var v: Int = 1
  public var people: [Person] = []
  /** the person chose explicit search (used only while an admin allows it); one choice for all their devices */
  public var explicit: Bool?
  public init() {}
}

public enum People {
  public static let threshold = 0.5 // SFace cosine: same person usually above 0.6, different people below 0.3
  public static let minFaces = 3
  public static let maxAnchors = 60

  public static func load(_ vault: Vault) async throws -> (doc: PeopleDoc, version: Int) {
    struct R: Decodable { let data_enc: String; let version: Int }
    do {
      let r = try await vault.api.get(R.self, "/api/me/blobs/people")
      let d = try Crypto.decryptPeople(B64.decode(r.data_enc), master: vault.masterKey(), userId: vault.userId)
      return (try JSONDecoder().decode(PeopleDoc.self, from: d), r.version)
    } catch let e as APIError where e.status == 404 {
      return (PeopleDoc(), 0)
    }
  }

  /** Saves a changed document; 409 means another device saved in between (the caller loads theirs and applies again). */
  public static func save(_ vault: Vault, _ doc: PeopleDoc, version: Int) async throws -> Int {
    struct R: Decodable { let version: Int }
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    let blob = Crypto.encryptPeople(try enc.encode(doc), master: try vault.masterKey(), userId: vault.userId)
    let d = try await vault.api.json("PUT", "/api/me/blobs/people", body: ["data_enc": B64.encode(blob), "version": version] as [String: Any])
    return try JSONDecoder().decode(R.self, from: d).version
  }
}

// ---- the search box: people, kinds, dates, file names, then what is in the photo ----

public enum Query {
  static let months: [String: Int] = {
    var m: [String: Int] = [:]
    for (i, n) in ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].enumerated() { m[n] = i; m[String(n.prefix(3))] = i }
    for (i, n) in ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"].enumerated() { m[n] = i; m[String(n.prefix(3))] = i }
    m["jänner"] = 0; m["maerz"] = 2; m["sept"] = 8
    return m
  }()

  /** A year, a month or both in the query; also "christmas" and "weihnachten" (day -1: the 20th to the 27th of December). */
  public static func parseDate(_ q: String) -> (year: Int?, month: Int?, day: Int?, rest: String) {
    var rest = q.lowercased()
    var year: Int?, month: Int?, day: Int?
    if let r = rest.range(of: #"\b(19[5-9]\d|20[0-9]\d)\b"#, options: .regularExpression) { year = Int(rest[r]); rest.replaceSubrange(r, with: " ") }
    for (name, m) in months.sorted(by: { $0.key.count > $1.key.count }) {
      if let r = rest.range(of: "(^|\\s)\(NSRegularExpression.escapedPattern(for: name))\\.?(\\s|$)", options: .regularExpression) {
        month = m; rest.replaceSubrange(r, with: " "); break
      }
    }
    if rest.range(of: #"\b(christmas|weihnachten|xmas)\b"#, options: .regularExpression) != nil { month = 11; day = -1 }
    return (year, month, day, rest.split(whereSeparator: \.isWhitespace).joined(separator: " "))
  }

  static func matches(_ w: String, _ pattern: String) -> Bool { w.range(of: pattern, options: .regularExpression) != nil }
  public static func isVideoWord(_ w: String) -> Bool { matches(w, "^(videos?|filme?|clips?)$") }
  public static func isFavWord(_ w: String) -> Bool { matches(w, "^(favou?rites?|favoriten?|liked|herz)$") }
  public static func isShotWord(_ w: String) -> Bool { matches(w, "^(screenshots?|bildschirmfotos?)$") }

  /** Ideas shown under an empty search box: everyday things the model knows well. */
  public static let suggestions = ["beach", "mountains", "snow", "sunset", "food", "dog", "cat", "car", "birthday cake", "flowers", "city at night", "document", "selfie", "forest", "lake"]
}
