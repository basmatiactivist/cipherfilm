// Search and people on the Mac: the model (downloaded from Hugging Face at pinned URLs, checked against fixed SHA-256
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

/** The model that says what is in a photo: LAION's OpenCLIP ViT-B/32, for everyone (docs/SEARCH.md, docs/MODELS.md).
 *  MobileCLIP S2, used before, was dropped for its license; explicit content is filtered from search instead
 *  (Explicit.swift). One case: the type stays, so the functions below keep their shape. */
public enum ClipModel: String, Sendable, Codable {
  case clip = "clip-b32"

  public var vision: ModelFile {
    ModelFile(name: "clip-b32-vision.onnx", url: "https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/visual/model.onnx", sha256: "b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c", size: 351_613_724, faces: false)
  }

  public var text: ModelFile {
    ModelFile(name: "clip-b32-text.onnx", url: "https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/textual/model.onnx", sha256: "48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722", size: 254_193_396, faces: false)
  }

  /** Index entry tags: bumped when the models or how their output is used change, entries with another are made again.
   *  The ones explicit search's LAION entries had, so those are kept. */
  public var tag: String { "laionb32+yunet23+sface21/1" }
  public var tagNoFaces: String { "laionb32/1" }

  /** The model family the server keeps entries under (`GET /api/index?model=`): the tag up to "+" or "/". */
  public var family: String { "laionb32" }

  /** Whether an entry's tag was made with this model (its image vector can be compared with this model's). */
  public func owns(_ tag: String?) -> Bool { tag == self.tag || tag == tagNoFaces }

  /** MobileCLIP's entries, made by this app before (and by older apps still): read only by the indexing device, which
   *  takes their faces over into the new entries (the people document names faces by their place in an entry), then
   *  deletes them (docs/SEARCH.md "One model"). */
  public static let legacyFamily = "mcs2"
  public static func legacyFaces(_ tag: String?) -> Bool { tag?.hasPrefix("mcs2+yunet23+sface21/") == true }
}

public enum Models {
  public static let tokenizer = ModelFile(name: "clip-b32-tokenizer.json", url: "https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/textual/tokenizer.json", sha256: "6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35", size: 3_642_073, faces: false)
  public static let faceFiles: [ModelFile] = [
    ModelFile(name: "yunet-2023mar.onnx", url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx", sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", size: 232_589, faces: true),
    ModelFile(name: "sface-2021dec.onnx", url: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx", sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79", size: 38_696_353, faces: true),
  ]

  public static func all(_ clip: ClipModel) -> [ModelFile] { [clip.vision, clip.text, tokenizer] + faceFiles }
  /** Every file any setting can need. */
  public static let every: [ModelFile] = all(.clip)

  public static let tag = ClipModel.clip.tag
  public static let tagNoFaces = ClipModel.clip.tagNoFaces

  /** Whether an entry is up to date: made with this model, and with faces when faces are wanted. */
  public static func good(_ tag: String?, faces: Bool, clip: ClipModel = .clip) -> Bool { faces ? tag == clip.tag : clip.owns(tag) }

  /** Whether the indexing device makes an entry for an item: a photo or video that decrypted and has a picture. */
  public static func indexable(_ it: Item) -> Bool { !it.broken && it.itemKey != nil && it.kind != .other && (it.hasPreview || it.hasThumb) }

  /** On a device that only reads the index: how many photos and videos still wait for the indexing device (no
   *  up-to-date entry yet). Shown with "Index on This Mac Instead", for when that device stopped indexing (it waits
   *  for its own OK to download the models after an update, or is gone; docs/SEARCH.md "One device indexes"). */
  public static func waiting(_ items: [Item], tags: [String: String], faces: Bool, clip: ClipModel = .clip) -> Int {
    items.filter { indexable($0) && !good(tags[$0.id], faces: faces, clip: clip) }.count
  }

  /** reader: a device that only reads the index (another one computes it) needs just the text model and the tokenizer. */
  public static func needed(faces: Bool, clip: ClipModel = .clip, reader: Bool = false) -> [ModelFile] {
    if reader { return [clip.text, tokenizer] }
    return all(clip).filter { faces || !$0.faces }
  }

  /** Files earlier versions downloaded: explicit search's LAION model under its old names (the same bytes, moved to the
   *  new ones instead of downloaded again; checked by SHA-256 as always), MobileCLIP's (deleted: its license doesn't
   *  allow their use). */
  public static let oldFiles: [(old: String, now: String?)] = [
    ("nsfw-laion-b32-vision.onnx", "clip-b32-vision.onnx"), ("nsfw-laion-b32-text.onnx", "clip-b32-text.onnx"),
    ("mobileclip-s2-vision.onnx", nil), ("mobileclip-s2-text.onnx", nil), ("mobileclip-s2-tokenizer.json", nil),
  ]

  /** A model file's bytes, read once and checked against its pinned SHA-256: what is loaded is exactly what was
   *  checked (nothing can swap the file between a check by its path and the load). */
  public static func verified(_ m: ModelFile, in dir: URL) throws -> Data {
    let d = try Data(contentsOf: dir.appendingPathComponent(m.name)) // read into memory, not mapped: later writes to the file don't reach it
    guard SHA256.hash(data: d).map({ String(format: "%02x", $0) }).joined() == m.sha256 else {
      throw CryptoError.failed("A search model didn't match its checksum and was not used.")
    }
    return d
  }

  public static func sha256(of url: URL) -> String? {
    guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? fh.close() }
    var h = SHA256()
    while let d = try? fh.read(upToCount: 4 << 20), !d.isEmpty { h.update(data: d) }
    return h.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

/** The yes to download the models from Hugging Face (docs/MODELS.md): a third party, which sees this Mac's IP address,
 *  so nothing is fetched from there before it. For the exact files (their SHA-256): explicit search's model, the face
 *  models or a new model in a later release ask again. This Mac's (any account), kept next to the models, so deleting
 *  them (turning search off) withdraws it. `at` is nil when the files were found already here (from before the question). */
public struct ModelConsent: Codable, Equatable, Sendable {
  public var at: Date?
  public var sha: [String]
}

/** Thrown by ModelStore.download for files the person hasn't agreed to download; bytes: what they would be. */
public struct NeedsConsent: Error, LocalizedError, Equatable {
  public let bytes: Int64
  public var errorDescription: String? { "Search needs your OK to download the models." }
}

/** Where the models live and whether they are there; a file is checked once per start. */
public final class ModelStore: @unchecked Sendable {
  public let dir: URL
  private let lock = NSLock()
  private var checked = Set<String>()
  /** How a file's SHA-256 is computed (tests stand in for the real model files). */
  var hash: @Sendable (URL) -> String? = { Models.sha256(of: $0) }

  public init(dir: URL) { self.dir = dir; tidyOldFiles() }

  /** Moves explicit search's LAION files to their new names and deletes MobileCLIP's (Models.oldFiles). */
  public func tidyOldFiles() {
    let fm = FileManager.default
    for (old, now) in Models.oldFiles {
      let from = dir.appendingPathComponent(old)
      try? fm.removeItem(at: dir.appendingPathComponent(old + ".part"))
      guard fm.fileExists(atPath: from.path) else { continue }
      if let now, !fm.fileExists(atPath: dir.appendingPathComponent(now).path) {
        if (try? fm.moveItem(at: from, to: dir.appendingPathComponent(now))) == nil { try? fm.removeItem(at: from) }
      } else {
        try? fm.removeItem(at: from)
      }
    }
  }

  // ---- the yes to download ----

  private var consentURL: URL { dir.appendingPathComponent("consent.json") }

  public func consent() -> ModelConsent? {
    guard let d = try? Data(contentsOf: consentURL) else { return nil }
    let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
    return try? dec.decode(ModelConsent.self, from: d)
  }

  private func save(_ c: ModelConsent?) {
    guard let c else { try? FileManager.default.removeItem(at: consentURL); return }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let enc = JSONEncoder(); enc.dateEncodingStrategy = .secondsSince1970
    try? enc.encode(c).write(to: consentURL, options: .atomic)
  }

  private func isChecked(_ m: ModelFile) -> Bool { lock.withLock { checked.contains(m.name) } }

  /** What a download would fetch that the person hasn't agreed to; empty when nothing needs asking. A file here counts
   *  only once its SHA-256 was checked (`have`, `checkHere`): one of the same name but another content (a model changed
   *  in a release) is asked for again, never taken as agreed by its name. */
  public func unagreed(faces: Bool, clip: ClipModel = .clip, reader: Bool = false) -> [ModelFile] {
    let sha = Set(consent()?.sha ?? [])
    return Models.needed(faces: faces, clip: clip, reader: reader).filter { !isChecked($0) && !sha.contains($0.sha256) }
  }

  /** Checks the hash of every model file here not checked yet this run; one with the wrong hash goes (downloaded again,
   *  after the question). Reads the files: not on the main thread. */
  public func checkHere() {
    for m in Models.every where !isChecked(m) {
      let f = dir.appendingPathComponent(m.name)
      guard FileManager.default.fileExists(atPath: f.path) else { continue }
      if hash(f) == m.sha256 { lock.withLock { _ = checked.insert(m.name) } } else { try? FileManager.default.removeItem(at: f) }
    }
  }

  /** The yes: what these settings need may be downloaded. */
  public func agree(faces: Bool, clip: ClipModel = .clip, reader: Bool = false, now: Date = Date()) {
    let old = consent()?.sha ?? []
    let add = Models.needed(faces: faces, clip: clip, reader: reader).map(\.sha256).filter { !old.contains($0) }
    save(ModelConsent(at: now, sha: old + add))
  }

  /** For Settings: when the models here were downloaded and how big they are; nil when there are none. Models from
   *  before this question was asked count as agreed, dated by their files. */
  public func downloaded() -> (at: Date?, bytes: Int64)? {
    let fm = FileManager.default
    let here = Models.every.filter { fm.fileExists(atPath: dir.appendingPathComponent($0.name).path) }
    guard !here.isEmpty else { return nil }
    var c = consent()
    let times = here.compactMap { (try? fm.attributesOfItem(atPath: dir.appendingPathComponent($0.name).path)[.modificationDate]) as? Date }
    // only files whose SHA-256 was checked are taken as agreed: the yes is for the exact files, not their names
    let verified = here.filter(isChecked)
    if verified.contains(where: { !(c?.sha.contains($0.sha256) ?? false) }) {
      let old = c?.sha ?? []
      c = ModelConsent(at: c?.at ?? times.min(), sha: old + verified.map(\.sha256).filter { !old.contains($0) })
      save(c)
    }
    return (c?.at ?? times.min(), here.reduce(0) { $0 + $1.size })
  }

  public func missingBytes(faces: Bool, clip: ClipModel = .clip, reader: Bool = false) -> Int64 {
    Models.needed(faces: faces, clip: clip, reader: reader).filter { !FileManager.default.fileExists(atPath: dir.appendingPathComponent($0.name).path) }.reduce(0) { $0 + $1.size }
  }

  public func have(faces: Bool, clip: ClipModel = .clip, reader: Bool = false) -> Bool {
    for m in Models.needed(faces: faces, clip: clip, reader: reader) {
      if lock.withLock({ checked.contains(m.name) }) { continue }
      let f = dir.appendingPathComponent(m.name)
      guard FileManager.default.fileExists(atPath: f.path) else { return false }
      guard hash(f) == m.sha256 else { try? FileManager.default.removeItem(at: f); return false }
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
  public func download(faces: Bool, clip: ClipModel = .clip, reader: Bool = false, progress: @escaping @Sendable (Progress) -> Void) async throws {
    // nothing goes to Hugging Face without the yes, whatever asked for it: a file already here with the right hash
    // isn't downloaded and needs none
    let sha = Set(consent()?.sha ?? [])
    let ask = Models.needed(faces: faces, clip: clip, reader: reader).filter { m in
      if lock.withLock({ checked.contains(m.name) }) || sha.contains(m.sha256) { return false }
      let f = dir.appendingPathComponent(m.name)
      return !(FileManager.default.fileExists(atPath: f.path) && hash(f) == m.sha256)
    }
    if !ask.isEmpty { throw NeedsConsent(bytes: ask.reduce(0) { $0 + $1.size }) }
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

  /** A device that only reads the index keeps no image or face models (hundreds of MB it would never run). */
  public func removeIndexing() { remove([ClipModel.clip.vision] + Models.faceFiles) }

  private func remove(_ files: [ModelFile]) {
    for m in files {
      lock.withLock { _ = checked.remove(m.name) }
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(m.name))
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(m.name + ".part"))
    }
    // what went is asked for again before it comes back
    if var c = consent() {
      let gone = Set(files.map(\.sha256))
      let left = c.sha.filter { !gone.contains($0) }
      if left.count != c.sha.count { c.sha = left; save(left.isEmpty ? nil : c) }
    }
  }

  /** Turning search off: the models go, and with them the yes to download them. */
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

  public init(analysis a: Analysis, faces: Bool, model: ClipModel = .clip) {
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

  /** The entries for one look at a photo, one per model in a.clips; the faces found, or those given (known: from the
   *  photo's MobileCLIP entry made before one model), so the people document's names stay with them. */
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
  /** the person chose explicit search: search without the explicit-content filter (only while an admin allows it, and
   *  never in an app that doesn't offer it); one choice for all their devices */
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
