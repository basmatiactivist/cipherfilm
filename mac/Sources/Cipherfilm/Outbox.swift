// Decrypted copies for leaving the app: dragging photos into the Finder or Mail, and Share…. They are written to a
// private folder in the app's caches only when asked for, and deleted at every lock, sign-out and start, and after an
// hour. (A photo you share has to exist decrypted somewhere; this keeps it as short as macOS allows.)
import AppKit
import CipherfilmCore
import UniformTypeIdentifiers

enum Outbox {
  static let dir: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent((Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac") + "/out", isDirectory: true)

  static func clear() { try? FileManager.default.removeItem(at: dir) }

  static func sweep() {
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey]) else { return }
    for f in files where ((try? f.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) < Date().addingTimeInterval(-3600) {
      try? FileManager.default.removeItem(at: f)
    }
  }

  /** The original, decrypted into its own folder under its own name. */
  static func file(_ it: Item, _ vault: Vault) async throws -> URL {
    guard it.openable, let folder = ServerId.folder(in: dir, it.id) else { throw CryptoError.failed("this item can't be read") }
    sweep()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard let url = FileName.inside(folder, FileName.of(it)) else { throw CryptoError.failed("bad file name") }
    if !FileManager.default.fileExists(atPath: url.path) {
      try await vault.saveOriginal(it, to: url)
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
    Task {
      var urls: [URL] = []
      for (n, it) in items.prefix(50).enumerated() {
        model.working = items.count == 1 ? "Preparing to share…" : "Preparing \(n + 1) of \(min(items.count, 50)) to share…"
        do { urls.append(try await file(it, vault)) } catch { model.alert = "\(it.name) couldn't be prepared: \(error.localizedDescription)" }
      }
      model.working = nil
      guard !urls.isEmpty, let view = window?.contentView else { return }
      let p = at.map { view.convert($0, from: nil) } ?? NSPoint(x: view.bounds.midX, y: view.bounds.midY)
      NSSharingServicePicker(items: urls).show(relativeTo: NSRect(x: p.x, y: p.y, width: 1, height: 1), of: view, preferredEdge: .minY)
    }
  }
}

extension Progress {
  func also(_ f: (Progress) -> Void) -> Progress { f(self); return self }
}
