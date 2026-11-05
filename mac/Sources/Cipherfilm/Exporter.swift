// Export: a decrypted copy of the library in a folder the person chose, one way (library -> folder). With "Keep up to
// date" it runs on its own while the library is unlocked (also with the window closed): new items within minutes,
// deleted ones out. Without it, "Export Now" does one pass. docs/MAC.md has the rules; in short:
// - layout: <year>/<year-month>/<name>, or by album: <album>/<name> (an item in several albums goes into the first one
//   only; items in no album go to "Not in an album/<year>/<year-month>/").
// - what: everything, favorites only, or chosen albums.
// - no duplicates: an item is written once (remembered in export.json); items with the same name and size (the same
//   photo uploaded twice) share one file; a file already at the right place with the same name and size is adopted,
//   not written again; a changed layout moves the files instead of writing new ones.
// - gone from the library (or no longer chosen): the copy goes to the macOS Trash if it is unchanged and no other
//   item shares it. Files you rename, move or delete inside the folder are left as they are.
import AppKit
import Foundation
import Observation
import CipherfilmCore

@MainActor @Observable
final class Exporter {
  enum Phase: Equatable { case off, working, idle, error }
  var phase: Phase = .off
  var done = 0
  var total = 0
  var message: String?
  var current: String?

  struct Entry: Codable { var path: String; var size: Int64; var mtime: Double; var print: String? }
  struct Manifest: Codable { var root: String; var userId: String; var entries: [String: Entry] = [:] }

  enum Layout: String, Codable, CaseIterable { case month, album }
  enum Scope: String, Codable, CaseIterable { case all, favorites, albums }

  private var run: Task<Void, Never>?
  private var vault: Vault?
  private var items: [Item] = []
  private var albums: [Album] = []
  private var settings = AccountSettings()
  private var again = false
  private var firstPassNotified = false

  static let marker = ".cipherfilm-export"

  func libraryChanged(vault: Vault, items: [Item], albums: [Album], settings: AccountSettings) {
    self.vault = vault; self.items = items; self.albums = albums; self.settings = settings
    guard settings.exportPath != nil, settings.exportOn else { stop(); return }
    guard settings.exportKeepUpToDate else { if run == nil { phase = .idle }; return }
    start()
  }

  /** One pass now (also when "Keep up to date" is off). */
  func exportNow() {
    guard vault != nil, settings.exportPath != nil else { return }
    start()
  }

  private func start() {
    if run != nil { again = true; return }
    run = Task { await self.loop() }
  }

  func stop() {
    run?.cancel(); run = nil
    phase = .off; current = nil; message = nil
  }

  private func file(_ userId: String) -> AccountFile<Manifest> { AccountFile(userId: userId, name: "export.json") }

  /** Whether a folder can hold this account's export: empty, or an export of this same account. */
  static func check(folder: URL, userId: String) -> String? {
    let fm = FileManager.default
    let m = folder.appendingPathComponent(marker)
    if let owner = try? String(contentsOf: m, encoding: .utf8) {
      return owner.trimmingCharacters(in: .whitespacesAndNewlines) == userId ? nil : "This folder holds the export of another account."
    }
    let visible = ((try? fm.contentsOfDirectory(atPath: folder.path)) ?? []).filter { !$0.hasPrefix(".") }
    return visible.isEmpty ? nil : "Choose an empty folder (or one Cipherfilm exported to before)."
  }

  private func loop() async {
    defer { run = nil }
    repeat {
      again = false
      await pass()
      if Task.isCancelled { return }
    } while again
  }

  /** What the person chose to export. */
  private func wanted() -> [Item] {
    let live = items.filter { !$0.broken && $0.meta != nil }
    switch settings.exportScope {
    case .all: return live
    case .favorites: return live.filter(\.favorite)
    case .albums:
      let ids = Set(albums.filter { settings.exportAlbums.contains($0.id) }.flatMap(\.itemIds))
      return live.filter { ids.contains($0.id) }
    }
  }

  static func clean(_ s: String) -> String {
    var t = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespaces)
    while t.hasPrefix(".") { t.removeFirst() }
    return t
  }

  /** The folder an item belongs in, relative to the export folder. */
  private func folder(_ it: Item, firstAlbum: [String: Album]) -> String {
    let c = Calendar.current.dateComponents([.year, .month], from: it.date)
    let month = String(format: "%04d/%04d-%02d", c.year ?? 1970, c.year ?? 1970, c.month ?? 1)
    switch settings.exportLayout {
    case .month: return month
    case .album:
      if let a = firstAlbum[it.id], !Self.clean(a.name).isEmpty { return Self.clean(a.name) }
      return "Not in an album/" + month
    }
  }

  private func pass() async {
    guard let vault, vault.isOpen, let path = settings.exportPath else { return }
    let root = URL(fileURLWithPath: path, isDirectory: true)
    let fm = FileManager.default
    let userId = vault.userId
    let mf = file(userId)
    var man = mf.read() ?? Manifest(root: path, userId: userId)
    if man.root != path || man.userId != userId { man = Manifest(root: path, userId: userId) }
    do {
      try fm.createDirectory(at: root, withIntermediateDirectories: true)
      if let problem = Self.check(folder: root, userId: userId), man.entries.isEmpty { throw APIError(status: -1, message: problem) }
      try userId.write(to: root.appendingPathComponent(Self.marker), atomically: true, encoding: .utf8)
    } catch {
      phase = .error; message = error.localizedDescription; return
    }

    let want = wanted()
    let wantIds = Set(want.map(\.id))
    var firstAlbum: [String: Album] = [:]
    for a in albums where !a.broken { for id in a.itemIds where firstAlbum[id] == nil { firstAlbum[id] = a } }

    // 1. gone from the library or no longer chosen: out, and its copy to the Trash if nothing else shares it
    for (id, e) in man.entries where !wantIds.contains(id) {
      man.entries.removeValue(forKey: id)
      let shared = man.entries.values.contains { $0.path == e.path }
      if settings.exportTrashRemoved && !shared { Self.trashIfUnchanged(root.appendingPathComponent(e.path), e) }
    }

    // 2. a changed layout or album: the unchanged file moves (never a second copy)
    var taken = Set(man.entries.values.map { $0.path.lowercased() })
    for it in want {
      guard let e = man.entries[it.id] else { continue }
      let dir = folder(it, firstAlbum: firstAlbum)
      guard (e.path as NSString).deletingLastPathComponent != dir else { continue }
      let from = root.appendingPathComponent(e.path)
      guard Self.unchanged(from, e) else { continue } // moved or edited by the person: theirs now
      let rel = Self.place(name: (e.path as NSString).lastPathComponent, dir: dir, taken: &taken, root: root)
      do {
        try fm.createDirectory(at: root.appendingPathComponent(dir), withIntermediateDirectories: true)
        try fm.moveItem(at: from, to: root.appendingPathComponent(rel))
        for (k, v) in man.entries where v.path == e.path { man.entries[k]?.path = rel }
        Self.removeEmptyDirs(from.deletingLastPathComponent(), stop: root)
      } catch {
        taken.remove(rel.lowercased())
      }
    }
    mf.write(man)

    // 3. new: written once
    var byPrint: [String: Entry] = [:]
    for e in man.entries.values { if let p = e.print { byPrint[p] = e } }
    let todo = want.filter { man.entries[$0.id] == nil }
    total = want.count
    done = total - todo.count
    phase = todo.isEmpty ? .idle : .working
    message = nil
    var written = 0
    for it in todo {
      if Task.isCancelled || !vault.isOpen { mf.write(man); return }
      let print = Crypto.fingerprint(name: it.name, size: it.size)
      // the same photo uploaded twice: one file
      if let twin = byPrint[print], fm.fileExists(atPath: root.appendingPathComponent(twin.path).path) {
        man.entries[it.id] = twin; done += 1; continue
      }
      let dir = folder(it, firstAlbum: firstAlbum)
      let name = Self.clean(it.name).isEmpty ? "photo-\(it.id.prefix(8))" : Self.clean(it.name)
      // already there (a folder exported before, a lost list): adopted, not written again
      let same = "\(dir)/\(name)"
      let sameURL = root.appendingPathComponent(same)
      if !taken.contains(same.lowercased()), let a = try? fm.attributesOfItem(atPath: sameURL.path), (a[.size] as? NSNumber)?.int64Value == it.size {
        let e = Entry(path: same, size: it.size, mtime: ((a[.modificationDate] as? Date) ?? it.date).timeIntervalSince1970, print: print)
        man.entries[it.id] = e; byPrint[print] = e; taken.insert(same.lowercased()); done += 1; continue
      }
      let rel = Self.place(name: name, dir: dir, taken: &taken, root: root)
      let dest = root.appendingPathComponent(rel)
      current = it.name
      do {
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try await vault.saveOriginal(it, to: dest)
        try fm.setAttributes([.creationDate: it.date, .modificationDate: it.date], ofItemAtPath: dest.path)
        let a = try fm.attributesOfItem(atPath: dest.path)
        let e = Entry(path: rel, size: (a[.size] as? NSNumber)?.int64Value ?? it.size, mtime: ((a[.modificationDate] as? Date) ?? it.date).timeIntervalSince1970, print: print)
        man.entries[it.id] = e; byPrint[print] = e
        done += 1; written += 1
        if done % 20 == 0 { mf.write(man) }
      } catch is CancellationError {
        mf.write(man); return
      } catch {
        taken.remove(rel.lowercased())
        message = "\(it.name): \(error.localizedDescription)"
        if (error as? APIError)?.status == 0 { mf.write(man); phase = .error; return } // offline: next pass
      }
    }
    mf.write(man)
    current = nil
    if phase != .error { phase = .idle }
    if written >= 20 && !firstPassNotified {
      firstPassNotified = true
      Notifier.post("Export up to date", "\(written) photos and videos were written to your export folder.")
    }
  }

  /** <dir>/<name>, with " (2)" before the extension when the name is taken. */
  static func place(name: String, dir: String, taken: inout Set<String>, root: URL) -> String {
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var rel = "\(dir)/\(name)"
    var n = 2
    while taken.contains(rel.lowercased()) || FileManager.default.fileExists(atPath: root.appendingPathComponent(rel).path) {
      rel = "\(dir)/\(base) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"); n += 1
    }
    taken.insert(rel.lowercased())
    return rel
  }

  static func unchanged(_ url: URL, _ e: Entry) -> Bool {
    guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return false }
    return (a[.size] as? NSNumber)?.int64Value == e.size && abs(((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) - e.mtime) < 2
  }

  static func trashIfUnchanged(_ url: URL, _ e: Entry) {
    guard unchanged(url, e) else { return }
    try? FileManager.default.trashItem(at: url, resultingItemURL: nil)
  }

  static func removeEmptyDirs(_ dir: URL, stop: URL) {
    var d = dir
    while d.path.hasPrefix(stop.path) && d.path != stop.path {
      let left = ((try? FileManager.default.contentsOfDirectory(atPath: d.path)) ?? ["?"]).filter { $0 != ".DS_Store" }
      guard left.isEmpty else { return }
      try? FileManager.default.removeItem(at: d)
      d = d.deletingLastPathComponent()
    }
  }

  /** Forgets files that are no longer where they were written, so the next pass exports them again. */
  func exportMissingAgain() {
    guard let vault, let path = settings.exportPath else { return }
    let mf = file(vault.userId)
    guard var man = mf.read() else { return }
    let root = URL(fileURLWithPath: path)
    man.entries = man.entries.filter { FileManager.default.fileExists(atPath: root.appendingPathComponent($0.value.path).path) }
    mf.write(man)
    exportNow()
  }

  /** At sign-out, when chosen: every unchanged exported copy goes to the Trash. */
  func trashEverything() async {
    stop()
    guard let userId = AppModel.shared.me?.user.id, let man = file(userId).read() else { return }
    let root = URL(fileURLWithPath: man.root)
    var seen = Set<String>()
    for e in man.entries.values where seen.insert(e.path).inserted { Self.trashIfUnchanged(root.appendingPathComponent(e.path), e) }
    try? FileManager.default.removeItem(at: root.appendingPathComponent(Self.marker))
  }
}
