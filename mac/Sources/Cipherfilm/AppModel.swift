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
  @ObservationIgnored private var liveTask: Task<Void, Never>?
  @ObservationIgnored private var liveFlush: Task<Void, Never>?
  @ObservationIgnored private var liveBatch = LiveBatch()
  @ObservationIgnored private var liveV: Int?
  @ObservationIgnored private var liveLast = Date.distantPast
  @ObservationIgnored private var liveTook: TimeInterval = 0

  private init() {}

  // ---- start, server, sign-in ----

  func start() async {
    Outbox.clear()
    agent.setUp()
    watchSleep()
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
      throw APIError(status: -1, message: "That address isn't a Cipherfilm server.")
    }
    a.invalidate()
    startOver()
    wipe(ended: true)
    UserDefaults.standard.set(url.absoluteString, forKey: "server")
    use(server: url)
    me = nil
    phase = .signedOut
    notice = nil
  }

  func forgetServer() {
    startOver()
    wipe(ended: true)
    UserDefaults.standard.removeObject(forKey: "server")
    api?.invalidate(); api = nil; server = nil; me = nil
    phase = .noServer
  }

  /** A sign-in waiting for its two-step code (the sign-in page then asks for it). */
  var codeStep: CodeStep?

  func login(email: String, password: String) async throws {
    guard let api else { return }
    codeStep?.abandon(); codeStep = nil
    switch try await Account.login(api: api, email: email, password: password) {
    case .done(let me, let master): adopt(me, master: master)
    case .code(let step): codeStep = step
    }
  }

  /** The code step: a wrong code may be tried again; an expired sign-in goes back to the password. */
  func finishSignIn(code: String) async throws {
    guard let api, let step = codeStep else { return }
    do {
      let (me, master) = try await Account.finish(api: api, step: step, code: code)
      codeStep = nil
      adopt(me, master: master)
    } catch let e as APIError where e.code == "two_factor_expired" {
      codeStep = nil
      throw e
    }
  }

  /** The code step with a passkey, in the browser (PasskeyBrowser): a passkey that isn't accepted may be tried again. */
  func finishSignInWithPasskey() async throws {
    guard let api, let step = codeStep else { return }
    do {
      let options = try await Account.passkeyChallenge(api: api, step: step)
      let answer = try await PasskeyBrowser.shared.run(server: api.base, op: "get", options: options)
      let (me, master) = try await Account.finish(api: api, step: step, passkey: answer)
      codeStep = nil
      adopt(me, master: master)
    } catch let e as APIError where e.code == "two_factor_expired" {
      codeStep = nil
      throw e
    }
  }

  /** Back to the password: the key the password made is forgotten. */
  func startOver() {
    codeStep?.abandon()
    codeStep = nil
  }

  // ---- notices (a new sign-in elsewhere, two-step sign-in turned off by an admin) ----

  var notices: [Notice] = []
  /** the Settings tab to show (the banner's "Review devices" opens Security) */
  var settingsTab = "general"

  func loadNotices() async {
    guard let api, phase == .unlocked else { return }
    if let l = try? await Notice.load(api: api), phase == .unlocked { notices = l }
  }

  func dismiss(_ n: Notice) {
    notices.removeAll { $0.id == n.id }
    guard let api else { return }
    Task { try? await Notice.dismiss(api: api, id: n.id) }
  }

  /** Fetches the account again (two-step sign-in turned on or off here). */
  func refreshMe() async {
    guard let api, let old = me, let fresh = try? JSONDecoder().decode(Me.self, from: try await api.json("GET", "/api/me")),
          fresh.user.id == old.user.id else { return }
    api.csrf = fresh.csrf
    me = fresh
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
      every(120)
      startLive(api, vault!)
      Task { await loadNotices() }
      agent.unlocked()
    } else {
      phase = .locked
    }
  }

  /** Lock when this Mac sleeps or its screen locks (on unless turned off in Settings), so a Mac left alone doesn't keep
   *  the library's key in memory. */
  static var lockOnSleep: Bool {
    get { UserDefaults.standard.object(forKey: "lockOnSleep") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "lockOnSleep") }
  }

  @ObservationIgnored private var sleepWatched = false
  private func watchSleep() {
    guard !sleepWatched else { return }
    sleepWatched = true
    let go: @Sendable (Notification) -> Void = { _ in Task { @MainActor in if AppModel.lockOnSleep { AppModel.shared.lock() } } }
    let ws = NSWorkspace.shared.notificationCenter
    for n in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      ws.addObserver(forName: n, object: nil, queue: .main, using: go)
    }
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main, using: go)
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
    TouchID.disable(userId) // its keychain item lives outside the account's folder
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
    watcher.stop(forget: true)
    wipe(ended: true)
    api?.clearCookies()
    if let userId { forget(account: userId) }
    me = nil
    settings = AccountSettings()
    api?.csrf = ""
    phase = .signedOut
  }

  /** Account › Delete Account: the server deletes the account and everything in it; then this Mac forgets it all, as at
   *  sign-out (the exported copies stay: they are the person's files now). */
  func deleteAccount(password: String) async throws {
    guard let me, let api else { return }
    try await Account.delete(api: api, me: me, password: password)
    watcher.stop(forget: true)
    wipe(ended: true)
    api.clearCookies()
    forget(account: me.user.id)
    self.me = nil
    settings = AccountSettings()
    api.csrf = ""
    phase = .signedOut
    notice = "Your account and everything in it were deleted."
  }

  /** Everything derived from the master key goes; "ended" also drops the encrypted cache's owner state. */
  private func wipe(ended: Bool) {
    refreshTimer?.invalidate(); refreshTimer = nil
    liveTask?.cancel(); liveTask = nil; liveFlush?.cancel(); liveFlush = nil; _ = liveBatch.take(); liveV = nil
    search.stop(clear: true)
    exporter.stop()
    Outbox.cancel()
    // after a lock the queue stays (saved in the account's folder) and goes on after the next unlock; once the session
    // is gone it is not this Mac's to finish (it never goes on in another account)
    vault?.close()
    vault = nil
    images.clear()
    PlaceBook.forget()
    Outbox.clear()
    items = []; byId = [:]; albums = []; trash = []; notices = []
    if ended { watcher.stop(forget: true); uploads = []; uploadsOwner = nil; uploadsPaused = false; Inbox.clear() }
  }

  /** The map is on: the person agreed to exactly the map servers the Cipherfilm server names now (AccountSettings). */
  var mapOn: Bool {
    get { let h = me?.map?.hosts ?? []; return !h.isEmpty && settings.mapAgreed == h }
    set { settings.mapAgreed = newValue ? (me?.map?.hosts ?? []) : [] }
  }

  // ---- the library ----

  /** Files dropped from apps that hand over only a temporary copy (Photos, Mail, browsers): copied into the app's
   *  own inbox first, so they are still there when their turn in the queue comes; deleted once uploaded, when the
   *  upload is cancelled or removed, at sign-out, and when no queued upload needs them any more. */
  enum Inbox {
    static let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/inbox", isDirectory: true)

    /** The inbox copy behind a queued file, if it is one. */
    static func drop(_ u: URL) {
      let folder = u.deletingLastPathComponent()
      if folder.deletingLastPathComponent().standardizedFileURL.path == dir.standardizedFileURL.path { try? FileManager.default.removeItem(at: folder) }
    }

    static func clear() { try? FileManager.default.removeItem(at: dir) }

    /** Copies no queued upload refers to (left by a crash or an older version). */
    static func sweep(keeping urls: [URL]) {
      let keep = Set(urls.map { $0.deletingLastPathComponent().standardizedFileURL.path })
      for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where !keep.contains(f.standardizedFileURL.path) {
        try? FileManager.default.removeItem(at: f)
      }
    }

    static func keep(_ u: URL) -> URL {
      let p = u.resolvingSymlinksInPath().path
      let temp = [FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path, "/private/var/folders", "/var/folders"].contains { p.hasPrefix($0) }
      guard temp, !p.hasPrefix(dir.path) else { return u }
      let target = dir.appendingPathComponent(UUID().uuidString, isDirectory: true)
      do {
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
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
      // only what changed since the last load (ListSync.swift, AlbumSync.swift)
      async let l = vault.syncLibrary()
      async let a = vault.loadAlbums()
      let (r, al) = try await (l, a)
      guard self.vault === vault else { return }
      // the server's list is the truth also when nothing changed: a change made here (favorite, trash) that the
      // server refused goes back
      setItems(r.items)
      let albumsChanged = al != albums
      albums = al
      loadError = nil
      guard r.changed || albumsChanged else { return }
      images.prefetch(Array(r.items.prefix(400)), vault)
      if r.changed { vault.pruneCache(keeping: Set(r.items.map(\.id))) }
      libraryChanged()
    } catch {
      if !quiet { loadError = error.localizedDescription }
    }
  }

  /** The lists load again every so often: every two minutes besides the live updates, more often while those don't
   *  get through. */
  private func every(_ seconds: TimeInterval) {
    if let t = refreshTimer, t.isValid, t.timeInterval == seconds { return }
    refreshTimer?.invalidate()
    refreshTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in Task { @MainActor in await AppModel.shared.refresh(quiet: true) } }
  }

  // ---- live updates (CipherfilmCore/Live.swift): what another device changed shows here within a second or two ----

  /** A flag the watchdog and the stream share (both on the main actor). */
  @MainActor private final class Attempt { var ready = false; var heldBack = false }

  private func startLive(_ api: API, _ vault: Vault) {
    liveTask?.cancel()
    liveTask = Task { await self.runLive(api, vault) }
  }

  /** Keeps the stream open while this vault is unlocked: reconnects with backoff, after a probe that also notices a
   *  session that ended; while something on the way holds the stream back (a proxy that buffers), the lists load every
   *  15 seconds instead. */
  private func runLive(_ api: API, _ vault: Vault) async {
    var tries = 0, heldBack = 0
    while !Task.isCancelled, self.vault === vault {
      let at = Attempt()
      let stream = Task { try await api.events { s in await self.live(s, at) } }
      let watchdog = Task {
        try? await Task.sleep(for: .seconds(10))
        if !Task.isCancelled, !at.ready { at.heldBack = true; stream.cancel() }
      }
      _ = await withTaskCancellationHandler { await stream.result } onCancel: { stream.cancel() }
      watchdog.cancel()
      if Task.isCancelled || self.vault !== vault { return }
      if at.ready { tries = 0; heldBack = 0 } else if at.heldBack { heldBack += 1 }
      if heldBack >= 3 { every(15) }
      while true {
        try? await Task.sleep(for: .seconds(liveBackoff(tries)))
        tries += 1
        if Task.isCancelled || self.vault !== vault { return }
        do { _ = try await api.json("GET", "/api/me/usage"); break } catch { continue }
      }
    }
  }

  private func live(_ s: LiveSignal, _ at: Attempt) -> Bool {
    guard vault != nil else { return false }
    switch s {
    case .ready(let v):
      at.ready = true
      every(120)
      // a stream that was gone a while may have missed pings (or the server restarted, with new counters)
      if let old = liveV, old != v { liveSchedule(Set(LiveTopic.allCases)) }
      liveV = v
    case .changed(let v, let what):
      liveV = v
      liveSchedule(what)
    case .bye: return false
    case .heartbeat: break
    }
    return true
  }

  /** Loads what was pinged 0.3 s after the first ping (a burst arrives as one), never two at once, and at least 1.5 s
   *  apart or twice as long as the last load took. */
  private func liveSchedule(_ what: Set<LiveTopic>) {
    liveBatch.add(what)
    guard liveFlush == nil, !liveBatch.pending.isEmpty else { return }
    let wait = max(0.3, liveLast.addingTimeInterval(max(1.5, 2 * liveTook)).timeIntervalSinceNow)
    liveFlush = Task {
      try? await Task.sleep(for: .seconds(wait))
      if Task.isCancelled { return }
      await self.liveApply()
    }
  }

  private func liveApply() async {
    let what = liveBatch.take()
    let began = Date()
    // this Mac's own uploads ping it too: the list loads once they are done (finish)
    if !what.isDisjoint(with: [.items, .albums]) && uploading == 0 { await refresh(quiet: true) }
    if what.contains(.trash) { await loadTrash(quiet: true) }
    if what.contains(.people) { search.peopleChangedElsewhere() }
    if what.contains(.notices) { await loadNotices() }
    liveTook = Date().timeIntervalSince(began)
    liveLast = Date()
    liveFlush = nil
    liveSchedule([])
  }

  func loadTrash() async { await loadTrash(quiet: false) }

  private func loadTrash(quiet: Bool) async {
    guard let vault else { return }
    do {
      let t = try await vault.loadTrash()
      trash = t.items; retentionDays = t.retentionDays
    } catch {
      if !quiet { loadError = error.localizedDescription }
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
        alert = "Couldn't turn on search: \(error.localizedDescription)"
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
    guard uploads.isEmpty, let saved = queueFile?.read(), !saved.isEmpty else { Inbox.sweep(keeping: uploads.map(\.url)); pump(); return }
    uploads = saved.map { var j = $0; if j.state == .running { j.state = .waiting; j.done = 0 }; return j }
    Inbox.sweep(keeping: uploads.map(\.url))
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
    uploads.removeAll {
      if case .running = $0.state { return false }; if case .waiting = $0.state { return false }
      Inbox.drop($0.url); return true
    }
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
    uploads.removeAll { if $0.id == id && $0.state != .running { Inbox.drop($0.url); return true }; return false }
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
