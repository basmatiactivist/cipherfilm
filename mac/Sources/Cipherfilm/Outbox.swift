// Decrypted copies for leaving the app: dragging photos into the Finder or Mail, and Share…. They are written to a
// private folder in the app's caches only when asked for, and deleted at every lock, sign-out, start and quit, and 15
// minutes after they were made, also while the app just runs on. (A photo you share has to exist decrypted somewhere;
// this keeps it as short as macOS allows. A crash leaves them until the next start.)
import AppKit
import CipherfilmCore
import UniformTypeIdentifiers

enum Outbox {
  static let dir: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/out", isDirectory: true)

  /** The running Share…, stopped at lock and sign-out (cancel()) so it decrypts nothing after. */
  @MainActor static var shareTask: Task<Void, Never>?
  /** The running Save…, stopped the same way. */
  @MainActor static var saveTask: Task<Void, Never>?

  static func clear() { try? FileManager.default.removeItem(at: dir) }

  /** How long a copy stays: time for Mail or the Finder to take it (the same as on Android). */
  static let keepFor: TimeInterval = 15 * 60
  @MainActor private static var sweeper: Timer?
  /** From launch on: copies older than keepFor go every minute, not only when the next one is made. */
  @MainActor static func sweepWhileRunning() {
    guard sweeper == nil else { return }
    sweeper = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
      DispatchQueue.global(qos: .utility).async { sweep() }
    }
  }

  /** Lock or sign-out: a Share… still preparing stops, and the folder goes (AppModel.wipe). */
  @MainActor static func cancel() { shareTask?.cancel(); shareTask = nil; saveTask?.cancel(); saveTask = nil }

  /** Copies being written now: the sweep leaves them, however long a big video takes to come down. */
  private static let busyLock = NSLock()
  nonisolated(unsafe) private static var busy = Set<String>()
  private static func isBusy(_ name: String) -> Bool { busyLock.lock(); defer { busyLock.unlock() }; return busy.contains(name) }
  private static func setBusy(_ name: String, _ on: Bool) { busyLock.lock(); if on { busy.insert(name) } else { busy.remove(name) }; busyLock.unlock() }

  static func sweep() {
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey]) else { return }
    // not Save…'s partial files: a long save writes there for as long as it takes (they go at lock, quit and start)
    for f in files where f.lastPathComponent != "staging" && !isBusy(f.lastPathComponent) && ((try? f.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) < Date().addingTimeInterval(-keepFor) {
      try? FileManager.default.removeItem(at: f)
    }
  }

  /** The original, decrypted into its own folder under its own name. */
  static func file(_ it: Item, _ vault: Vault) async throws -> URL {
    guard it.openable, let folder = ServerId.folder(in: dir, it.id) else { throw CryptoError.failed("this item can't be read") }
    // only while the library is unlocked: after a lock nothing more is decrypted, and what was being written goes
    guard vault.isOpen else { throw CancellationError() }
    setBusy(folder.lastPathComponent, true)
    defer { setBusy(folder.lastPathComponent, false) }
    sweep()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // handed out (again) now: its 15 minutes start now, also for a copy made earlier
    try? FileManager.default.setAttributes([.creationDate: Date()], ofItemAtPath: folder.path)
    guard let url = FileName.inside(folder, FileName.of(it)) else { throw CryptoError.failed("bad file name") }
    if !FileManager.default.fileExists(atPath: url.path) {
      try await vault.saveOriginal(it, to: url)
      guard vault.isOpen, !Task.isCancelled else { try? FileManager.default.removeItem(at: folder); throw CancellationError() }
      try? FileManager.default.setAttributes([.creationDate: it.date, .modificationDate: it.date], ofItemAtPath: url.path)
    }
    return url
  }

  /** For a drag: the item id (albums take it) and the decrypted file, made only when it is dropped somewhere. */
  @MainActor static func provider(_ it: Item) -> NSItemProvider {
    let p = NSItemProvider(object: it.id as NSString)
    guard let vault = AppModel.shared.vault, it.openable else { return p }
    let type = UTType(mimeType: it.meta?.mime ?? "") ?? UTType(filenameExtension: (it.name as NSString).pathExtension) ?? .data
    p.suggestedName = it.name
    p.registerFileRepresentation(forTypeIdentifier: type.identifier, fileOptions: [], visibility: .all) { done in
      let task = Task {
        do { done(try await file(it, vault), false, nil) } catch { done(nil, false, error) }
      }
      return Progress.discreteProgress(totalUnitCount: 1).also { $0.cancellationHandler = { task.cancel() } }
    }
    return p
  }

  /** Share…: decrypts the items (with a note while it does), then shows macOS's share menu where the click was. */
  @MainActor static func share(_ all: [Item], _ model: AppModel) {
    let items = all.filter(\.openable)
    if items.count < all.count { model.alert = all.count == 1 ? "This item can't be read, so it can't be shared." : "Items that can't be read were left out." }
    guard let vault = model.vault, !items.isEmpty else { return }
    let window = NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible && $0.canBecomeMain }
    let at = window.map { $0.convertPoint(fromScreen: NSEvent.mouseLocation) }
    shareTask?.cancel()
    shareTask = Task {
      var urls: [URL] = []
      for (n, it) in items.prefix(50).enumerated() {
        guard !Task.isCancelled, vault.isOpen else { model.working = nil; return }
        model.working = items.count == 1 ? "Preparing to share…" : "Preparing \(n + 1) of \(min(items.count, 50)) to share…"
        do { urls.append(try await file(it, vault)) }
        catch is CancellationError { model.working = nil; return }
        catch { model.alert = "\(it.name) couldn't be prepared: \(error.localizedDescription)" }
      }
      model.working = nil
      guard !Task.isCancelled, vault.isOpen, !urls.isEmpty, let view = window?.contentView else { return }
      let p = at.map { view.convert($0, from: nil) } ?? NSPoint(x: view.bounds.midX, y: view.bounds.midY)
      NSSharingServicePicker(items: urls).show(relativeTo: NSRect(x: p.x, y: p.y, width: 1, height: 1), of: view, preferredEdge: .minY)
    }
  }
}

extension Progress {
  func also(_ f: (Progress) -> Void) -> Progress { f(self); return self }
}
