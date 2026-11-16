// Import from WebDAV folders (docs/MAC.md "Import from a WebDAV folder"): each folder in Settings › Import is listed
// (flat, one PROPFIND), the files the library doesn't have yet are streamed from the server through the same
// encryption as a local upload, a few at a time, and recorded per folder so an interrupted import goes on where it
// stopped. Only while the library is unlocked: a lock, sleep or sign-out stops it at once (the file in progress is
// discarded on the server and comes again next time). The passwords are in the keychain, readable by this app only;
// sign-out deletes them with the bookkeeping.
import AppKit
import CipherfilmCore
import Foundation
import Observation

/** The WebDAV passwords: one keychain item per folder, under a service of the account's own, so signing out of one
 *  account deletes exactly its passwords. */
enum WebDAVPasswords {
  static func service(_ userId: String) -> String { "app.cipherfilm.mac.webdav.\(userId)" }
  static func set(_ password: String, userId: String, source: String) throws {
    try Keychain.set(Data(password.utf8), service: service(userId), account: source, label: "Cipherfilm WebDAV import")
  }
  static func get(userId: String, source: String) -> String? {
    Keychain.get(service: service(userId), account: source).map { String(decoding: $0, as: UTF8.self) }
  }
  static func delete(userId: String, source: String) { Keychain.delete(service: service(userId), account: source) }
  static func deleteAll(userId: String) { Keychain.deleteAll(service: service(userId)) }
}

@MainActor @Observable
final class WebDAVImporter {
  struct Status {
    enum Phase: Equatable { case idle, listing, importing, done, paused, problem }
    var phase: Phase = .idle
    var problem: String?
    var plan: WebDAVImport.Plan?
    var uploaded = 0
    var bytesDone: Int64 = 0
    var bytesTotal: Int64 = 0
    /** bytes a second over the last seconds */
    var speed: Double = 0
    var current: [String] = []
    var errors: [String] = []
    var givenUp: [(name: String, why: String)] = []
    var imported = 0
    var lastChecked: Date?
  }

  private(set) var status: [String: Status] = [:]
  var running: Bool { task != nil }

  private var api: API?
  private var userId: String?
  private var settings = AccountSettings()
  private var unlocked = false
  /** the library's names and sizes (Crypto.fingerprint), in memory only; nil until the library loaded after unlock */
  private var known: Set<String>?
  /** the same of the locked folder's items (WebDAVImport.plan reads those files and drops them) */
  private var knownLocked: Set<String> = []
  private var task: Task<Void, Never>?
  private var timer: Timer?
  private var again = false
  private var generation = 0 { didSet { live.set(generation) } }
  private let live = Live()
  private var asleep = false

  static let temp: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/webdav", isDirectory: true)

  init() {
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in AppModel.shared.webdav.sleep(true) }
    }
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in AppModel.shared.webdav.sleep(false) }
    }
  }

  private func book(_ userId: String, _ id: String) -> ImportBook {
    ImportBook(file: Paths.account(userId).appendingPathComponent("webdav/\(Self.safe(id)).log"))
  }
  static func safe(_ id: String) -> String { id.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) != nil ? id : "invalid" }

  /** The account and its settings; unlocked: whether the library is (imports run only then). */
  func configure(api: API, userId: String, settings: AccountSettings, unlocked: Bool) {
    if self.userId != userId { stop(forget: true) }
    self.api = api; self.userId = userId; self.settings = settings; self.unlocked = unlocked
    let ids = Set(settings.webdav.map(\.id))
    for k in status.keys where !ids.contains(k) { status.removeValue(forKey: k) }
    for s in settings.webdav where status[s.id] == nil {
      var st = Status()
      let b = book(userId, s.id)
      st.imported = b.doneCount; st.givenUp = b.givenUp
      st.phase = s.paused ? .paused : s.finished ? .done : .idle
      status[s.id] = st
    }
    if !unlocked { stop(); return }
    if timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in Task { @MainActor in AppModel.shared.webdav.tick() } }
    }
    tick()
  }

  /** The decrypted library (with the locked folder's items): files it has are not imported again. */
  func libraryChanged(_ all: [Item]) {
    known = Set(all.filter { !$0.isLocked }.compactMap { it in it.meta.map { Crypto.fingerprint(name: $0.name, size: $0.size) } })
    knownLocked = Set(all.filter(\.isLocked).compactMap { it in it.meta.map { Crypto.fingerprint(name: $0.name, size: $0.size) } })
    tick()
  }

  /** Lock, sleep: the pass in progress stops (nothing more is read or decrypted); forget: sign-out, nothing of the
   *  account stays in memory. */
  func stop(forget: Bool = false) {
    generation += 1
    task?.cancel(); task = nil
    timer?.invalidate(); timer = nil
    known = nil; knownLocked = []
    again = false
    unlocked = false
    for k in status.keys where status[k]?.phase == .listing || status[k]?.phase == .importing {
      status[k]?.phase = .idle; status[k]?.current = []; status[k]?.speed = 0
    }
    if forget { api = nil; userId = nil; settings = AccountSettings(); status = [:]; unlocked = false }
    try? FileManager.default.removeItem(at: Self.temp)
  }

  private func sleep(_ on: Bool) {
    asleep = on
    if on {
      generation += 1
      task?.cancel(); task = nil
      for k in status.keys where status[k]?.phase == .listing || status[k]?.phase == .importing { status[k]?.phase = .idle; status[k]?.current = [] }
    } else {
      tick()
    }
  }

  /** The next folder that is due, if nothing runs. */
  func tick() {
    guard task == nil else { again = true; return }
    guard unlocked, !asleep, known != nil, api != nil, userId != nil, settings.pubkey != nil else { return }
    let now = Date()
    let due = settings.webdav.first { s in
      guard !s.paused, !s.finished else { return false }
      guard let last = status[s.id]?.lastChecked else { return true }
      // an import once that stopped early (offline, lock) goes on at the next minute; a kept-up one at its interval
      if status[s.id]?.phase == .problem { return now.timeIntervalSince(last) >= 60 * Double(min(s.interval, 5)) }
      return s.keepImporting ? now.timeIntervalSince(last) >= 60 * Double(max(1, s.interval)) : false
    }
    if let due { run(due) }
  }

  /** Import Now: at once, also before its time. */
  func importNow(_ id: String) {
    status[id]?.lastChecked = nil
    if let i = AppModel.shared.settings.webdav.firstIndex(where: { $0.id == id }) {
      AppModel.shared.settings.webdav[i].finished = false
      AppModel.shared.settings.webdav[i].paused = false
    }
    tick()
  }

  func pause(_ id: String, _ on: Bool) {
    if let i = AppModel.shared.settings.webdav.firstIndex(where: { $0.id == id }) { AppModel.shared.settings.webdav[i].paused = on }
    if on {
      if status[id]?.phase == .importing || status[id]?.phase == .listing { generation += 1; task?.cancel(); task = nil }
      status[id]?.phase = .paused; status[id]?.current = []; status[id]?.speed = 0
    } else {
      status[id]?.phase = .idle
      tick()
    }
  }

  func retry(_ id: String) {
    guard let userId else { return }
    let b = book(userId, id)
    b.retryGivenUp()
    status[id]?.givenUp = []; status[id]?.errors = []
    importNow(id)
  }

  /** Removes the folder: its password and its bookkeeping go; what it imported stays in the library. */
  func remove(_ id: String) {
    if task != nil, status[id]?.phase == .importing || status[id]?.phase == .listing { generation += 1; task?.cancel(); task = nil }
    if let userId {
      WebDAVPasswords.delete(userId: userId, source: id)
      try? FileManager.default.removeItem(at: Paths.account(userId).appendingPathComponent("webdav/\(Self.safe(id)).log"))
    }
    AppModel.shared.settings.webdav.removeAll { $0.id == id }
    status.removeValue(forKey: id)
  }

  /** "Only files added from now on": what the folder holds now counts as imported. */
  func baseline(_ id: String, _ listing: WebDAVListing) {
    guard let userId else { return }
    book(userId, id).baseline(listing.files)
  }

  private func run(_ src: WebDAVSource) {
    guard let api, let userId, let pkB64 = settings.pubkey, let pk = try? B64.decode(pkB64), let known, case let locked = knownLocked,
          let folder = URL(string: src.url) else { return }
    guard let password = WebDAVPasswords.get(userId: userId, source: src.id) else {
      status[src.id]?.phase = .problem
      status[src.id]?.problem = "The password isn't in the keychain anymore. Remove this folder and add it again."
      status[src.id]?.lastChecked = Date()
      return
    }
    let gen = generation
    let flag = live
    let parallel = min(6, max(1, settings.webdavParallel))
    let id = src.id
    var st = status[id] ?? Status()
    st.phase = .listing; st.problem = nil; st.errors = []; st.uploaded = 0; st.bytesDone = 0; st.current = []; st.speed = 0
    status[id] = st
    task = Task {
      @MainActor func stillOn() -> Bool { gen == generation && !Task.isCancelled }
      let client = WebDAVClient(folder: folder, user: src.user, password: password)
      defer {
        client.invalidate()
        // a pass stopped before (lock, then a quick unlock) leaves the temporary folder to the one running now
        if gen == generation {
          try? FileManager.default.removeItem(at: Self.temp)
          task = nil
          if again { again = false; tick() }
        }
      }
      let b = book(userId, id)
      do {
        let listing = try await client.list()
        guard stillOn() else { return }
        let plan = WebDAVImport.plan(listing, book: b, known: known, locked: locked)
        status[id]?.plan = plan
        status[id]?.bytesTotal = plan.bytes
        status[id]?.phase = .importing
        try FileManager.default.createDirectory(at: Self.temp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // the speed: bytes uploaded over a sliding window of a few seconds
        let meter = Meter()
        let retryable = Counter() // files that failed this pass but have tries left
        let ticker = Task { @MainActor in
          while !Task.isCancelled, gen == generation {
            status[id]?.speed = meter.rate()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
          }
        }
        defer { ticker.cancel() }
        try await WebDAVImport.run(plan.todo, client: client, api: api, wrap: .sealed(pk: pk), book: b, parallel: parallel, temp: Self.temp,
                                   readOnly: plan.readOnly, live: { if flag.get() != gen { throw Stopped() } }) { ev in
          if case .bytes(let n) = ev { meter.add(n) }
          if case .failed(_, _, false) = ev { retryable.add(1) }
          Task { @MainActor in
            guard gen == self.generation else { return }
            switch ev {
            case .started(let name, _): self.status[id]?.current.append(name)
            case .bytes(let n): self.status[id]?.bytesDone += n
            case .alreadyThere(let name):
              self.status[id]?.current.removeAll { $0 == name }
            case .uploaded(let name, _):
              self.status[id]?.current.removeAll { $0 == name }
              self.status[id]?.uploaded += 1
              self.status[id]?.imported += 1
            case .failed(let name, let why, let gaveUp):
              self.status[id]?.current.removeAll { $0 == name }
              self.status[id]?.errors = Array(([name + ": " + why] + (self.status[id]?.errors ?? [])).prefix(50))
              if gaveUp { self.status[id]?.givenUp = b.givenUp }
            }
          }
        }
        guard stillOn() else { return }
        status[id]?.phase = src.keepImporting ? .idle : .done
        status[id]?.current = []; status[id]?.speed = 0
        status[id]?.lastChecked = Date()
        status[id]?.givenUp = b.givenUp
        b.compact()
        // an import once is finished when nothing is left but files given up on (Retry Failed tries those again);
        // files with tries left go again right away (at most three times each)
        if !src.keepImporting, retryable.value > 0 {
          status[id]?.phase = .idle; status[id]?.lastChecked = nil; again = true
        } else if !src.keepImporting, let i = AppModel.shared.settings.webdav.firstIndex(where: { $0.id == id }) {
          AppModel.shared.settings.webdav[i].finished = true
        }
        let n = status[id]?.uploaded ?? 0
        if n > 0 {
          await AppModel.shared.refresh(quiet: true)
          Notifier.post("WebDAV import", "\(n) photo\(n == 1 ? "" : "s") and video\(n == 1 ? "" : "s") from \(src.label) encrypted and uploaded.")
        }
      } catch {
        guard stillOn() else { return }
        status[id]?.phase = .problem
        status[id]?.current = []; status[id]?.speed = 0
        status[id]?.lastChecked = Date()
        status[id]?.problem = Self.message(error)
        if (status[id]?.uploaded ?? 0) > 0 { await AppModel.shared.refresh(quiet: true) }
      }
    }
  }

  static func message(_ e: Error) -> String {
    if let a = e as? APIError {
      switch a.status {
      case 413: return "Your storage on the server is full."
      case 401: return "Signed out. Sign in to keep importing."
      default: return "Can't reach your Cipherfilm server. Trying again in a few minutes."
      }
    }
    return e.localizedDescription
  }

  /** Test Connection and Add: the folder's listing with what an import would do. */
  static func test(url: URL, user: String, password: String, book: ImportBook?, known: Set<String>) async -> Result<WebDAVImport.Plan, Error> {
    let c = WebDAVClient(folder: url, user: user, password: password)
    defer { c.invalidate() }
    do {
      let l = try await c.list()
      return .success(WebDAVImport.plan(l, book: book ?? ImportBook(file: nil), known: known))
    } catch {
      return .failure(error)
    }
  }

  static func listing(url: URL, user: String, password: String) async throws -> WebDAVListing {
    let c = WebDAVClient(folder: url, user: user, password: password)
    defer { c.invalidate() }
    return try await c.list()
  }

  var knownPrints: Set<String> { known ?? [] }
}

/** Bytes over the last few seconds. */
final class Meter: @unchecked Sendable {
  private let lock = NSLock()
  private var samples: [(Date, Int64)] = []
  func add(_ n: Int64) { lock.withLock { samples.append((Date(), n)); trim() } }
  func rate(window: TimeInterval = 5) -> Double {
    lock.withLock {
      trim(window)
      guard let first = samples.first else { return 0 }
      let span = max(1, Date().timeIntervalSince(first.0))
      return Double(samples.reduce(0) { $0 + $1.1 }) / span
    }
  }
  private func trim(_ window: TimeInterval = 5) {
    let cut = Date().addingTimeInterval(-window)
    if let i = samples.firstIndex(where: { $0.0 >= cut }) { samples.removeFirst(i) } else { samples.removeAll() }
  }
}
