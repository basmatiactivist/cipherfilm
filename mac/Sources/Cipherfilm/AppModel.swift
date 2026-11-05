// Who is signed in, whether the library is unlocked, and the decrypted library. The master key lives in memory only;
// a lock or sign-out forgets it together with everything decrypted (images, the search index, the people list).
import AppKit
import Foundation
import Observation
import CipherfilmCore

enum Phase: Equatable { case starting, noServer, signedOut, locked, unlocked }

struct UploadJob: Identifiable, Equatable, Codable {
  enum State: Equatable, Codable { case waiting, running, done, failed(String) }
  var id = UUID()
  let url: URL
  var name: String { url.lastPathComponent }
  var done: Int64 = 0
  var total: Int64 = 1
  var state: State = .waiting
}

@MainActor @Observable
final class AppModel {
  static let shared = AppModel()

  var phase: Phase = .starting
  var server: URL?
  var me: Me?
  var notice: String?
  private(set) var api: API?
  private(set) var vault: Vault?

  var items: [Item] = []
  private(set) var byId: [String: Item] = [:]
  var albums: [Album] = []
  var trash: [Item] = []
  var retentionDays = 30
  var loading = false
  var loadError: String?
  var uploads: [UploadJob] = []
  /** the window's navigation and selection, for the menu commands */
  @ObservationIgnored weak var nav: Navigator?
  @ObservationIgnored weak var selection: Selection?

  /** What the Photo menu acts on: the photo in the viewer, else the selection. */
  var targets: [String] {
    if let v = nav?.viewer { return [v.id] }
    return Array(selection?.ids ?? [])
  }

  /** a problem to show over everything (also over the viewer) */
  var alert: String?
  /** a short task the person waits for ("Preparing to share…"), shown as a small panel */
  var working: String?

  var settings = AccountSettings() {
    didSet { if let id = me?.user.id, settings != oldValue { settings.save(id); settingsChanged(from: oldValue) } }
  }

  let images = ImageStore()
  let search = SearchEngine()
  let exporter = Exporter()
  let watcher = Watcher()
  let agent = Agent()

  private var refreshTimer: Timer?

  private init() {}

  // ---- start, server, sign-in ----

  func start() async {
    Outbox.clear()
    agent.setUp()
    guard let s = UserDefaults.standard.string(forKey: "server"), let url = URL(string: s) else { phase = .noServer; return }
    use(server: url)
    do {
      let me = try JSONDecoder().decode(Me.self, from: try await api!.json("GET", "/api/me"))
      adopt(me, master: nil)
    } catch let e as APIError {
      phase = .signedOut
      notice = e.status == 0 ? e.message : nil
      // signed out from another device (or expired) while the app was closed: nothing of the account stays here
      if e.status == 401, forgetAccounts() { notice = e.code == "revoked" ? e.message : "Your session ended. Sign in again." }
    } catch {
      phase = .signedOut
    }
  }

  private func use(server url: URL) {
    api?.invalidate()
    server = url
    let a = API(base: url)
    a.onSessionEnded = { revoked in Task { @MainActor in AppModel.shared.sessionEnded(revoked: revoked) } }
    api = a
  }

  /** Checks that the address answers like a Cipherfilm before remembering it. */
  func chooseServer(_ input: String) async throws {
    let url = try API.origin(input)
    let a = API(base: url)
    do {
      _ = try await a.json("GET", "/api/setup/status")
    } catch let e as APIError where e.status == 0 || e.status == -2 {
      throw e
    } catch {
      throw APIError(status: -1, message: "That address answers, but not like a Cipherfilm.")
    }
    a.invalidate()
    wipe(ended: true)
    UserDefaults.standard.set(url.absoluteString, forKey: "server")
    use(server: url)
    me = nil
    phase = .signedOut
    notice = nil
  }

  func forgetServer() {
    wipe(ended: true)
    UserDefaults.standard.removeObject(forKey: "server")
    api?.invalidate(); api = nil; server = nil; me = nil
    phase = .noServer
  }

  func login(email: String, password: String) async throws {
    guard let api else { return }
    let (me, master) = try await Account.login(api: api, email: email, password: password)
    adopt(me, master: master)
  }

  /** Touch ID unlock is set up on this Mac for the signed-in account. */
  var touchID = false

  func enableTouchID() async throws {
    guard let me, let v = vault else { throw APIError(status: -1, message: "Unlock your library first.") }
    try await TouchID.enable(master: try v.masterKey(), userId: me.user.id)
    touchID = TouchID.enabled(me.user.id)
  }

  func disableTouchID() {
    guard let me else { return }
    TouchID.disable(me.user.id)
    touchID = false
  }

  /** Returns false when the person cancelled. */
  func unlockWithTouchID() async throws -> Bool {
    guard let me else { return false }
    do {
      guard let key = try await TouchID.unlock(me: me) else { return false }
      adopt(me, master: key)
      return true
    } catch {
      touchID = TouchID.enabled(me.user.id)
      throw error
    }
  }

  func unlock(password: String) async throws {
    guard let me else { return }
    let key = try await Task.detached { try Account.unlock(me: me, password: password) }.value
    adopt(me, master: key)
  }

  private func adopt(_ me: Me, master: Data?) {
    if let old = self.me, old.user.id != me.user.id { wipe(ended: true) }
    api?.csrf = me.csrf
    self.me = me
    settings = AccountSettings.load(me.user.id)
    touchID = TouchID.enabled(me.user.id)
    notice = nil
    watcher.configure(api: api!, userId: me.user.id, settings: settings)
    if let master, let api {
      vault = Vault(api: api, me: me, masterKey: master)
      phase = .unlocked
      if let cached = vault!.loadCachedLibrary() { setItems(cached); images.prefetch(Array(cached.prefix(400)), vault!) }
      Task { await refresh() }
      restoreUploads()
      refreshTimer?.invalidate()
      refreshTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { _ in Task { @MainActor in await AppModel.shared.refresh(quiet: true) } }
      agent.unlocked()
    } else {
      phase = .locked
    }
  }

  /** Locks the library: the key leaves memory; the session stays (and with it the watched folders). */
  func lock() {
    guard phase == .unlocked else { return }
    wipe(ended: false)
    phase = .locked
  }

  /** The server ended the session (the person signed this Mac out from another device, or it expired, 30 days after
   *  its last use or a year after sign-in): the same as
   *  signing out here, except the server already forgot the session and the exported copies stay. */
  private func sessionEnded(revoked: Bool) {
    guard phase == .unlocked || phase == .locked else { return }
    wipe(ended: true)
    api?.clearCookies()
    if let id = me?.user.id { forget(account: id) }
    me = nil
    settings = AccountSettings()
    api?.csrf = ""
    phase = .signedOut
    notice = revoked ? "This Mac was signed out from another device." : "Your session ended. Sign in again."
  }

  /** Deletes the account's folders; only for an id of the server's shape, so the paths stay inside the app's own. */
  private func forget(account userId: String) {
    guard ServerId.valid(userId) else { return }
    try? FileManager.default.removeItem(at: Paths.account(userId))
    if let dir = Vault.cacheDir(of: userId) { try? FileManager.default.removeItem(at: dir) }
  }

  /** Removes what accounts left on this Mac when its session is gone; true if there was something. */
  @discardableResult
  private func forgetAccounts() -> Bool {
    let root = Paths.support.appendingPathComponent("accounts", isDirectory: true)
    let ids = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    for id in ids {
      forget(account: id)
      try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true)) // a name from this folder's own listing
    }
    api?.clearCookies()
    return !ids.isEmpty
  }

  /** Sign-out: nothing of the account stays on this Mac (the search models do; they hold nothing of anyone). With
   *  deleteExport the exported copies go to the Trash too. */
  func signOut(deleteExport: Bool) async {
    let userId = me?.user.id
    if deleteExport { await exporter.trashEverything() }
    try? await api?.json("POST", "/api/auth/logout")
    watcher.stop()
    wipe(ended: true)
    api?.clearCookies()
    if let userId { forget(account: userId) }
    me = nil
    settings = AccountSettings()
    api?.csrf = ""
    phase = .signedOut
  }

  /** Everything derived from the master key goes; "ended" also drops the encrypted cache's owner state. */
  private func wipe(ended: Bool) {
    refreshTimer?.invalidate(); refreshTimer = nil
    search.stop(clear: true)
    exporter.stop()
    // after a lock the queue stays (saved in the account's folder) and goes on after the next unlock; once the session
    // is gone it is not this Mac's to finish (it never goes on in another account)
    vault?.close()
    vault = nil
    images.clear()
    Outbox.clear()
    items = []; byId = [:]; albums = []; trash = []
    if ended { watcher.stop(); uploads = []; uploadsOwner = nil; uploadsPaused = false }
  }

  // ---- the library ----

  /** Files dropped from apps that hand over only a temporary copy (Photos, Mail, browsers): copied into the app's
   *  own inbox first, so they are still there when their turn in the queue comes; deleted once uploaded. */
  enum Inbox {
    static let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/inbox", isDirectory: true)

    static func keep(_ u: URL) -> URL {
      let p = u.resolvingSymlinksInPath().path
      let temp = [FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path, "/private/var/folders", "/var/folders"].contains { p.hasPrefix($0) }
      guard temp, !p.hasPrefix(dir.path) else { return u }
      let target = dir.appendingPathComponent(UUID().uuidString, isDirectory: true)
      do {
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let dest = target.appendingPathComponent(u.lastPathComponent)
        try FileManager.default.copyItem(at: u, to: dest)
        return dest
      } catch {
        return u
      }
    }
  }

  private func setItems(_ list: [Item]) {
    items = list
    byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
  }

  func item(_ id: String) -> Item? { byId[id] }

  /** Which Cipherfilm this is, as people know it: the host (and the port when it isn't the default). */
  var serverName: String {
    guard let s = server, let h = s.host else { return "" }
    if let p = s.port, p != 443 { return "\(h):\(p)" }
    return h
  }

  func refresh(quiet: Bool = false) async {
    guard let vault, phase == .unlocked else { return }
    if !quiet { loading = true }
    defer { loading = false }
    do {
      async let l = vault.loadLibrary()
      async let a = vault.loadAlbums()
      let (list, al) = try await (l, a)
      guard self.vault === vault else { return }
      setItems(list)
      albums = al
      loadError = nil
      images.prefetch(Array(list.prefix(400)), vault)
      vault.pruneCache(keeping: Set(list.map(\.id)))
      libraryChanged()
    } catch {
      if !quiet { loadError = error.localizedDescription }
    }
  }

  func loadTrash() async {
    guard let vault else { return }
    do {
      let t = try await vault.loadTrash()
      trash = t.items; retentionDays = t.retentionDays
    } catch {
      loadError = error.localizedDescription
    }
  }

  /** Turns search on; where an admin allowed explicit search, with the model the person chose (nil: not asked). */
  func turnOnSearch(explicit: Bool?) {
    settings.searchAsked = true
    guard let explicit, let vault else { settings.search = true; return }
    Task {
      do {
        try await search.choose(explicit: explicit, vault: vault)
        settings.search = true
      } catch {
        alert = "Search wasn't turned on: \(error.localizedDescription)"
      }
    }
  }

  /** The library changed: the background work gets the new list. */
  private func libraryChanged() {
    guard let vault else { return }
    watcher.remember(library: items)
    search.libraryChanged(vault: vault, items: items, settings: settings)
    exporter.libraryChanged(vault: vault, items: items, albums: albums, settings: settings)
  }

  private func settingsChanged(from old: AccountSettings) {
    watcher.configure(api: api!, userId: me!.user.id, settings: settings)
    if settings.watchOn && !old.watchOn && phase == .unlocked { watcher.remember(library: items) } // before its first pass
    if let vault {
      search.libraryChanged(vault: vault, items: items, settings: settings)
      exporter.libraryChanged(vault: vault, items: items, albums: albums, settings: settings)
    }
  }

  // ---- changes ----

  func perform(_ what: @escaping (Vault) async throws -> Void) {
    guard let vault else { return }
    Task {
      do { try await what(vault) } catch { self.loadError = error.localizedDescription }
      await self.refresh(quiet: true)
    }
  }

  func setFavorite(_ ids: [String], _ on: Bool) {
    for id in ids { if var it = byId[id] { it.favorite = on; byId[id] = it } }
    items = items.map { ids.contains($0.id) ? (byId[$0.id] ?? $0) : $0 }
    perform { try await $0.setFavorite(ids, on) }
  }

  func moveToTrash(_ ids: [String]) {
    let gone = Set(ids)
    setItems(items.filter { !gone.contains($0.id) })
    perform { try await $0.trash(ids) }
  }

  func restore(_ ids: [String]) {
    let back = Set(ids)
    trash.removeAll { back.contains($0.id) }
    perform { try await $0.restore(ids) }
  }

  func purge(_ ids: [String]) {
    let gone = Set(ids)
    trash.removeAll { gone.contains($0.id) }
    perform { try await $0.purge(ids) }
  }

  // ---- uploads (drag and drop, the file picker): item keys under the master key ----
  // The queue is kept in the account's folder (file paths only), so a quit, restart or lock doesn't lose it: it goes on
  // after the next unlock. A file whose upload was cut off starts again (the server drops the unfinished one).

  private var uploading = 0
  var uploadsPaused = false { didSet { if !uploadsPaused { pump() } } }
  /** the account the queue in memory belongs to */
  private var uploadsOwner: String?
  private var queueFile: AccountFile<[UploadJob]>? { me.map { AccountFile(userId: $0.user.id, name: "uploads.json") } }

  private func saveQueue() { queueFile?.write(uploads.filter { $0.state != .done }) }

  private func restoreUploads() {
    if uploadsOwner != me?.user.id { uploads = []; uploadsPaused = false }
    uploadsOwner = me?.user.id
    guard uploads.isEmpty, let saved = queueFile?.read(), !saved.isEmpty else { pump(); return }
    uploads = saved.map { var j = $0; if j.state == .running { j.state = .waiting; j.done = 0 }; return j }
    pump()
  }

  func upload(_ urls: [URL]) {
    let urls = urls.map(Inbox.keep)
    var files: [URL] = []
    for u in urls {
      var dir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: u.path, isDirectory: &dir) else { continue }
      if dir.boolValue {
        let e = FileManager.default.enumerator(at: u, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants])
        while let f = e?.nextObject() as? URL { if Media.isMedia(f) { files.append(f) } }
      } else {
        files.append(u)
      }
    }
    // the same file twice in the queue goes up once
    if uploadsOwner == nil { uploadsOwner = me?.user.id }
    let queued = Set(uploads.filter { $0.state != .done }.map(\.url.path))
    uploads.removeAll { $0.state == .done }
    uploads += files.filter { !queued.contains($0.path) }.map { UploadJob(url: $0) }
    saveQueue()
    pump()
  }

  func clearFinishedUploads() {
    uploads.removeAll { if case .running = $0.state { return false }; if case .waiting = $0.state { return false }; return true }
    saveQueue()
  }

  func retry(_ id: UUID? = nil) {
    for i in uploads.indices where id == nil || uploads[i].id == id {
      if case .failed = uploads[i].state { uploads[i].state = .waiting; uploads[i].done = 0 }
    }
    saveQueue()
    pump()
  }

  func cancelUpload(_ id: UUID) {
    uploads.removeAll { $0.id == id && $0.state != .running }
    saveQueue()
  }

  private func pump() {
    guard let vault, let api, !uploadsPaused, phase == .unlocked, uploadsOwner == vault.userId else { return }
    while uploading < 4, let i = uploads.firstIndex(where: { $0.state == .waiting }) {
      uploading += 1
      uploads[i].state = .running
      let job = uploads[i]
      saveQueue()
      Task {
        do {
          guard FileManager.default.fileExists(atPath: job.url.path) else { throw APIError(status: -1, message: "The file is no longer there.") }
          let master = try vault.masterKey()
          // reading, encrypting and thumbnailing run off the main thread; progress comes back to it
          let url = job.url, id = job.id
          _ = try await Task.detached(priority: .userInitiated) {
            try await Uploader.upload(url, api: api, wrap: .master(master), live: { if !vault.isOpen { throw Stopped() } }) { done, total in
              Task { @MainActor in
                if let k = AppModel.shared.uploads.firstIndex(where: { $0.id == id }) { AppModel.shared.uploads[k].done = done; AppModel.shared.uploads[k].total = total }
              }
            }
          }.value
          if url.path.hasPrefix(Inbox.dir.path) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
          self.finish(job.id, .done)
        } catch is Stopped {
          self.finish(job.id, .waiting) // locked: goes on after the next unlock
        } catch {
          self.finish(job.id, .failed(error.localizedDescription))
        }
      }
    }
  }

  private func finish(_ id: UUID, _ state: UploadJob.State) {
    uploading -= 1
    if let k = uploads.firstIndex(where: { $0.id == id }) { uploads[k].state = state; if state == .waiting { uploads[k].done = 0 } }
    saveQueue()
    pump()
    if !uploads.contains(where: { $0.state == .running }) {
      Task { await refresh(quiet: true) }
      if !uploads.contains(where: { $0.state == .waiting }) {
        let ok = uploads.filter { $0.state == .done }.count, bad = uploads.filter { if case .failed = $0.state { return true }; return false }.count
        if ok + bad > 0 { Notifier.post("Upload finished", bad == 0 ? "\(ok) item\(ok == 1 ? "" : "s") encrypted and uploaded." : "\(ok) uploaded, \(bad) failed.") }
      }
    }
  }

  /** Something runs in the background: the menu-bar icon shows a dot. */
  var busy: Bool {
    uploadProgress != nil || exporter.phase == .working || watcher.running || [.download, .indexing].contains(search.phase)
  }

  var uploadProgress: (done: Int, total: Int, fraction: Double)? {
    let active = uploads
    guard active.contains(where: { $0.state == .running || $0.state == .waiting }) else { return nil }
    let done = active.filter { $0.state == .done }.count
    let bytesTotal = active.reduce(Int64(0)) { $0 + max(1, $1.total) }
    let bytesDone = active.reduce(Int64(0)) { $0 + ($1.state == .done ? max(1, $1.total) : $1.done) }
    return (done, active.count, Double(bytesDone) / Double(max(1, bytesTotal)))
  }
}
