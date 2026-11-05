// Watched folders: new photos and videos in the folders the person chose are encrypted here and uploaded, seconds
// after they appear (FSEvents) and in a full pass every ten minutes. Like the Android backup this needs no master key:
// each new item key is sealed to the account's public key (pinned when the feature was turned on, after checking it
// against the private key), so it keeps working while the library is locked, and it can add photos but read none.
// Files the library already has (same name and size) and files uploaded before are skipped.
import CoreServices
import Foundation
import Observation
import CipherfilmCore

@MainActor @Observable
final class Watcher {
  var running = false
  var current: String?
  var uploaded = 0
  var waiting = 0
  var problem: String?
  var lastDone: Date?
  var skipped: [String] = []

  struct State: Codable {
    var done: Set<String> = []
    var failures: [String: Int] = [:]
    var uploaded = 0
  }

  private var api: API?
  private var userId: String?
  private var settings = AccountSettings()
  private var stream: FSEventStreamRef?
  private var timer: Timer?
  private var task: Task<Void, Never>?
  private var again = false
  private var generation = 0 { didSet { live.set(generation) } }
  /** the generation, readable from the upload's own threads: a stop or sign-out ends a running upload */
  private let live = Live()

  private func stateFile(_ u: String) -> AccountFile<State> { AccountFile(userId: u, name: "watch.json") }
  private func knownFile(_ u: String) -> AccountFile<[String]> { AccountFile(userId: u, name: "known.json") }

  func configure(api: API, userId: String, settings: AccountSettings) {
    let was = (self.settings.watchOn, self.settings.watched, self.userId)
    self.api = api; self.userId = userId; self.settings = settings
    let on = settings.watchOn && settings.pubkey != nil && !settings.watched.isEmpty
    if !on { stop(); return }
    if was.0 && was.1 == settings.watched && was.2 == userId && stream != nil { return }
    stop()
    uploaded = stateFile(userId).read()?.uploaded ?? 0
    startStream(settings.watched.map(\.path))
    timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in Task { @MainActor in AppModel.shared.watcher.scan() } }
    changed() // first pass in a moment, after the library's names and sizes are written
  }

  func stop() {
    generation += 1
    task?.cancel(); task = nil
    timer?.invalidate(); timer = nil
    if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s); stream = nil }
    running = false; current = nil
  }

  /** Called with the decrypted library: photos that are already there (from the phone or the web) are skipped. */
  func remember(library: [Item]) {
    guard let userId, settings.watchOn else { return }
    let prints = library.compactMap { it in it.meta.map { Crypto.fingerprint(name: $0.name, size: $0.size) } }
    knownFile(userId).write(prints)
  }

  /** "Only new files" for a folder just added: what is in it now counts as done. */
  func baseline(_ folder: URL) {
    guard let userId else { return }
    let f = stateFile(userId)
    var st = f.read() ?? State()
    for u in Self.media(in: folder) { st.done.insert(u.print) }
    f.write(st)
  }

  private func startStream(_ paths: [String]) {
    var ctx = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
    let cb: FSEventStreamCallback = { _, _, _, _, _, _ in
      Task { @MainActor in AppModel.shared.watcher.changed() }
    }
    guard let s = FSEventStreamCreate(nil, cb, &ctx, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 2.0,
                                      FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)) else { return }
    FSEventStreamSetDispatchQueue(s, .main)
    FSEventStreamStart(s)
    stream = s
  }

  private var debounce: Task<Void, Never>?
  private func changed() {
    debounce?.cancel()
    debounce = Task { try? await Task.sleep(nanoseconds: 3_000_000_000); if !Task.isCancelled { scan() } }
  }

  struct Candidate: Sendable { let url: URL; let size: Int64; let modified: Date; var print: String { Crypto.fingerprint(name: url.lastPathComponent, size: size) } }

  nonisolated static func media(in folder: URL) -> [Candidate] {
    let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
    guard let e = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
    var out: [Candidate] = []
    while let u = e.nextObject() as? URL {
      guard let v = try? u.resourceValues(forKeys: Set(keys)), v.isRegularFile == true, Media.isMedia(u) else { continue }
      out.append(Candidate(url: u, size: Int64(v.fileSize ?? 0), modified: v.contentModificationDate ?? .distantPast))
    }
    return out.sorted { $0.modified < $1.modified }
  }

  func scan() {
    if task != nil { again = true; return }
    guard let api, let userId, let pkB64 = settings.pubkey, let pk = try? B64.decode(pkB64) else { return }
    let folders = settings.watched
    let faces = settings.faces, search = settings.search, explicit = settings.explicitSeen
    var clip = ClipModel.mobileclip
    var indexes = true
    let gen = generation
    running = true; problem = nil
    task = Task {
      defer { Task { @MainActor in self.task = nil; self.running = false; self.current = nil; if self.again { self.again = false; self.scan() } } }
      do {
        struct MeLite: Decodable { struct U: Decodable { let id: String; let nsfw: Bool? }; let user: U; let csrf: String; let session_id: String?; let indexer: String? }
        let me = try JSONDecoder().decode(MeLite.self, from: try await api.json("GET", "/api/me"))
        guard me.user.id == userId else { problem = "Signed in with another account. Turn watched folders on again."; return }
        api.csrf = me.csrf
        clip = ClipModel.choose(allowed: me.user.nsfw == true, explicit: explicit)
        // only the indexing device computes entries (docs/SEARCH.md); on the others the new photo waits for it
        indexes = (me.indexer ?? "").isEmpty || me.indexer == me.session_id
      } catch let e as APIError {
        problem = e.status == 401 ? "You were signed out. Sign in to continue uploading watched folders." : "Can't reach the server. Trying again later."
        return
      } catch { return }
      let sf = stateFile(userId)
      var st = sf.read() ?? State()
      let uploadedAtStart: Int? = st.uploaded
      let known = Set(knownFile(userId).read() ?? [])
      var todo: [Candidate] = []
      for f in folders where FileManager.default.fileExists(atPath: f.path) {
        let found = await Task.detached(priority: .utility) { Self.media(in: f.url) }.value
        todo += found.filter { c in !known.contains(c.print) && !st.done.contains(c.print) && Date().timeIntervalSince(c.modified) > 5 }
      }
      waiting = todo.count
      for c in todo {
        guard gen == generation, !Task.isCancelled else { return }
        // still being written (copied in, exported from a camera)? next pass
        guard let size = (try? FileManager.default.attributesOfItem(atPath: c.url.path)[.size] as? NSNumber)?.int64Value, size == c.size else { continue }
        current = c.url.lastPathComponent
        do {
          let flag = live
          let id = try await Uploader.upload(c.url, api: api, wrap: .sealed(pk: pk), live: { if flag.get() != gen { throw Stopped() } })
          if search && indexes { await SearchEngine.indexFile(c.url, id: id, video: Media.kind(name: c.url.lastPathComponent, mime: Media.mime(of: c.url)) == .video, faces: faces, clip: clip, pk: pk, api: api) }
          st.done.insert(c.print); st.failures.removeValue(forKey: c.print); st.uploaded += 1
          uploaded = st.uploaded
          waiting -= 1
          sf.write(st)
        } catch is Stopped {
          return
        } catch let e as APIError where e.status == 0 || e.status == 401 || e.status == 413 || e.status >= 500 {
          problem = e.status == 413 ? "Your storage on the server is full." : e.status == 401 ? "You were signed out. Sign in to continue uploading watched folders." : "Can't reach the server right now. Trying again later."
          sf.write(st); return
        } catch {
          let tries = (st.failures[c.print] ?? 0) + 1
          st.failures[c.print] = tries
          if tries >= 3 { // this file can't be read or uploaded: leave it and go on
            st.done.insert(c.print); st.failures.removeValue(forKey: c.print)
            skipped = Array(([c.url.lastPathComponent + ": " + error.localizedDescription] + skipped).prefix(50))
          }
          waiting -= 1
          sf.write(st)
        }
      }
      lastDone = Date()
      let now = st.uploaded - (uploadedAtStart ?? st.uploaded)
      if now > 0 {
        await AppModel.shared.refresh(quiet: true)
        Notifier.post("Watched folders", "\(now) new photo\(now == 1 ? "" : "s") and video\(now == 1 ? "" : "s") encrypted and uploaded.")
      }
    }
  }

}

final class Live: @unchecked Sendable {
  private let lock = NSLock()
  private var v = 0
  func set(_ x: Int) { lock.withLock { v = x } }
  func get() -> Int { lock.withLock { v } }
}
