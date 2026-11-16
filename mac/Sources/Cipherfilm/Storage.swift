// What this Mac keeps, and where. Per account (deleted at sign-out): the settings below, the watched folders' and the
// export's bookkeeping, and the encrypted cache. For the Mac: the server address and the search models (they hold
// nothing of anyone, so they stay, as on Android).
import Foundation
import CipherfilmCore

enum Paths {
  static let support: URL = {
    let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: u.path)
    return u
  }()
  static let models = support.appendingPathComponent("models", isDirectory: true)
  static func account(_ userId: String) -> URL {
    let safe = ServerId.valid(userId) ? userId : "invalid"
    return support.appendingPathComponent("accounts/\(safe)", isDirectory: true)
  }

  /** A file of the account's (settings, bookkeeping, the Touch ID copy): readable by this user only, its folders too,
   *  whatever the home folder's permissions are. */
  static func write(_ d: Data, to f: URL) {
    let fm = FileManager.default
    try? fm.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var p = f.deletingLastPathComponent()
    while p.path.hasPrefix(support.path + "/") { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: p.path); p = p.deletingLastPathComponent() }
    if (try? d.write(to: f, options: .atomic)) != nil { try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path) }
  }
}

/** A decrypted item's name as a file name: one path component (the name comes from the item's metadata, which can say
 *  anything), so whatever is written lands in the folder it is meant for. */
enum FileName {
  static func clean(_ s: String) -> String {
    var t = s.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: "\u{0}", with: "")
      .trimmingCharacters(in: .whitespaces)
    while t.hasPrefix(".") { t.removeFirst() }
    return t
  }

  static func of(_ it: Item) -> String {
    let c = clean(it.name)
    return c.isEmpty ? clean("photo-\(it.id.prefix(8))") : c
  }

  /** "name (k).ext" for the k-th file of the same name. */
  static func numbered(_ name: String, _ k: Int) -> String {
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    return ext.isEmpty ? "\(base) (\(k))" : "\(base) (\(k)).\(ext)"
  }

  /** dir/name, only when that is directly inside dir. */
  static func inside(_ dir: URL, _ name: String) -> URL? {
    let u = dir.appendingPathComponent(name)
    return u.standardizedFileURL.deletingLastPathComponent().path == dir.standardizedFileURL.path ? u : nil
  }
}

struct WatchedFolder: Codable, Hashable, Identifiable {
  var path: String
  /** files that were there when the folder was added and should not be uploaded (when "only new files" was chosen) */
  var baselineDone: Bool = false
  var id: String { path }
  var url: URL { URL(fileURLWithPath: path, isDirectory: true) }
}

/** A WebDAV folder to import from. */
struct WebDAVSource: Codable, Hashable, Identifiable {
  var id = UUID().uuidString
  /** the folder's address, as WebDAVAddress accepted it */
  var url: String
  var user: String
  /** false: import once, then stop; true: look for new files every `interval` minutes and at every unlock */
  var keepImporting = false
  var interval = 15
  var paused = false
  /** an "import once" that went through the whole folder */
  var finished = false
  var label: String {
    guard let u = URL(string: url) else { return url }
    let name = u.lastPathComponent.removingPercentEncoding ?? u.lastPathComponent
    return (name.isEmpty || name == "/" ? "" : name + " on ") + (u.host ?? url)
  }
}

/** The account's settings on this Mac. Everything here can be turned on and off in Settings. */
struct AccountSettings: Codable, Equatable {
  // search and people
  var search = false
  var faces = true
  var searchAsked = false
  /** index while running on battery too (off: only on power) */
  var indexOnBattery = true
  /** text in photos: the indexing Mac reads the text in them (its model is downloaded after the person's OK; off
   *  deletes it) */
  var textInPhotos = true
  // continuous export
  var exportOn = false
  var exportPath: String?
  var exportTrashRemoved = true
  /** run on its own (new items within minutes); off: only "Export Now" */
  var exportKeepUpToDate = true
  var exportLayout: Exporter.Layout = .month
  var exportScope: Exporter.Scope = .all
  var exportAlbums: [String] = []
  // watched folders
  var watchOn = false
  var watched: [WatchedFolder] = []
  var watchIncludeExisting = false
  /** the account's public key, checked against its private key when watched folders or a WebDAV import were turned on */
  var pubkey: String?
  // WebDAV import (WebDAVImporter.swift); each source's password is in the keychain, its progress in webdav/<id>.log
  var webdav: [WebDAVSource] = []
  /** files imported at the same time */
  var webdavParallel = WebDAVImport.defaultParallel
  // this Mac
  var agentAsked = false
  /** the map (MapPage.swift): the map servers the person agreed to (Me.MapStyles.hosts); empty until they turn the map
   *  on, because its images come from a third party. Another map server on the Cipherfilm server asks again. */
  var mapAgreed: [String] = []

  static func load(_ userId: String) -> AccountSettings {
    let f = Paths.account(userId).appendingPathComponent("settings.json")
    // fields added later get their defaults: the saved values are laid over the defaults before decoding
    guard let d = try? Data(contentsOf: f), let saved = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let defaults = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(AccountSettings())) as? [String: Any],
          let merged = try? JSONSerialization.data(withJSONObject: defaults.merging(saved) { _, b in b }),
          let s = try? JSONDecoder().decode(AccountSettings.self, from: merged) else { return AccountSettings() }
    return s
  }

  func save(_ userId: String) {
    if let d = try? JSONEncoder().encode(self) { Paths.write(d, to: Paths.account(userId).appendingPathComponent("settings.json")) }
  }
}

/** A small JSON file in the account's folder. */
struct AccountFile<T: Codable> {
  let userId: String
  let name: String
  var url: URL { Paths.account(userId).appendingPathComponent(name) }
  func read() -> T? { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(T.self, from: $0) } }
  func write(_ v: T) {
    if let d = try? JSONEncoder().encode(v) { Paths.write(d, to: url) }
  }
  /** For work that finishes after an await: written only while the account's folder is still there, so a sign-out
   *  that deleted it meanwhile isn't undone. */
  func writeIfPresent(_ v: T) {
    var dir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: Paths.account(userId).path, isDirectory: &dir), dir.boolValue else { return }
    write(v)
  }
}
