// What this Mac keeps, and where. Per account (deleted at sign-out): the settings below, the watched folders' and the
// export's bookkeeping, and the encrypted cache. For the Mac: the server address and the search models (they hold
// nothing of anyone, so they stay, as on Android).
import Foundation
import CipherfilmCore

enum Paths {
  static let support: URL = {
    let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
  }()
  static let models = support.appendingPathComponent("models", isDirectory: true)
  static func account(_ userId: String) -> URL {
    let safe = userId.range(of: "^[0-9A-Za-z_-]{1,64}$", options: .regularExpression) != nil ? userId : "invalid"
    return support.appendingPathComponent("accounts/\(safe)", isDirectory: true)
  }
}

struct WatchedFolder: Codable, Hashable, Identifiable {
  var path: String
  /** files that were there when the folder was added and should not be uploaded (when "only new files" was chosen) */
  var baselineDone: Bool = false
  var id: String { path }
  var url: URL { URL(fileURLWithPath: path, isDirectory: true) }
}

/** The account's settings on this Mac. Everything here can be turned on and off in Settings. */
struct AccountSettings: Codable, Equatable {
  // search and people
  var search = false
  var faces = true
  var searchAsked = false
  /** index while running on battery too (off: only on power) */
  var indexOnBattery = true
  /** the explicit-search choice last read from the people document, for indexing watched folders while locked */
  var explicitSeen = false
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
  /** the account's public key, checked against its private key when watched folders were turned on */
  var pubkey: String?
  // this Mac
  var agentAsked = false

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
    let dir = Paths.account(userId)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    if let d = try? JSONEncoder().encode(self) { try? d.write(to: dir.appendingPathComponent("settings.json"), options: .atomic) }
  }
}

/** A small JSON file in the account's folder. */
struct AccountFile<T: Codable> {
  let userId: String
  let name: String
  var url: URL { Paths.account(userId).appendingPathComponent(name) }
  func read() -> T? { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(T.self, from: $0) } }
  func write(_ v: T) {
    try? FileManager.default.createDirectory(at: Paths.account(userId), withIntermediateDirectories: true)
    if let d = try? JSONEncoder().encode(v) { try? d.write(to: url, options: .atomic) }
  }
}
