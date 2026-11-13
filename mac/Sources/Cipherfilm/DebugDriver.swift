// Debug builds only: drives the real app through its main flows against the throwaway test server
// (mobile/dev/compose.yaml) and writes "CFTEST PASS/FAIL" lines plus window snapshots. Never part of a release build.
//   CF_AUTOTEST=1 CF_TEST_CA=<root.crt> CF_TEST_SERVER=https://localhost:8443 CF_TEST_EMAIL=… CF_TEST_PASSWORD=…
//   CF_TEST_DIR=<scratch folder with files to upload> CF_SNAPSHOTS=<folder> [CF_APPEARANCE=dark]
// CF_MAP=1: only the map's checks (an account with located photos; nothing is changed on the server).
// CF_SIGNIN_ONLY=1: signs in and stops there, the app stays open. CF_INDEX_ONLY=1: signs in and indexes for search.
// Everything it makes in CF_TEST_DIR (copies, exports of the whole library, watched folders) is deleted at the start
// and the end of a run; only upload/ stays. CF_KEEP=1 keeps the last run's.
#if DEBUG
import AppKit
import AVFoundation
import CipherfilmCore
import SwiftUI

@MainActor
enum DebugDriver {
  static let env = ProcessInfo.processInfo.environment
  static var failures = 0

  static func log(_ s: String) { print("CFTEST \(s)"); fflush(stdout) }
  static func check(_ ok: Bool, _ what: String) { log("\(ok ? "PASS" : "FAIL") \(what)"); if !ok { failures += 1 } }

  static func wait(_ what: String, timeout: Double = 60, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if cond() { return true }; try? await Task.sleep(nanoseconds: 250_000_000) }
    log("TIMEOUT \(what)")
    return false
  }

  /** "Index on This Mac Instead" as the person does it: the role first, then the question for the image models (a Mac
   *  that only read deleted them, and with them the yes to download them: docs/MODELS.md), the yes, and the indexing.
   *  Settings asks before it calls indexHere; asked afterwards, the run waits in .consent until the yes, the same gate.
   *  Returns whether it asked (the image models weren't here). */
  @discardableResult
  static func takeOverIndexing(_ api: API) async throws -> Bool {
    let m = AppModel.shared
    try await m.search.indexHere(api: api)
    _ = await wait("taking over: the run starts", timeout: 120) { m.search.phase != .off && m.search.phase != .loading }
    let asked = m.search.phase == .consent
    if asked { m.search.agree(m.search.pendingAsk()) }
    if !(await wait("indexing here again", timeout: 1200) { m.search.indexes && m.search.phase == .ready }) {
      log("  search phase \(m.search.phase), indexes \(m.search.indexes), \(m.search.message ?? "-"), indexer \(m.me?.indexer ?? "-") (this Mac \(m.me?.session_id ?? "-"))")
    }
    return asked
  }

  static func snapshot(_ name: String) {
    guard let dir = env["CF_SNAPSHOTS"], let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.frame.width > 500 }), let v = w.contentView else { return }
    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
    v.cacheDisplay(in: v.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
  }

  /** Deletes what earlier runs left in CF_TEST_DIR: an export is a copy of the whole library, and a few runs fill a disk. */
  static func cleanTestDir() {
    guard let dir = env["CF_TEST_DIR"] else { return }
    let root = URL(fileURLWithPath: dir)
    for f in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where f.lastPathComponent != "upload" {
      try? FileManager.default.removeItem(at: f)
    }
  }

  static func snapshotFolder(_ url: URL) {
    let list = (FileManager.default.enumerator(atPath: url.path)?.allObjects as? [String] ?? []).filter { !$0.contains("/.") && !$0.hasPrefix(".") }.sorted()
    log("export folder:\n  " + list.prefix(40).joined(separator: "\n  "))
  }

  struct Page: Decodable { struct E: Decodable { let item_id: String }; let entries: [E] }

  static func run() async {
    guard env["CF_AUTOTEST"] == "1" else { return }
    // never in the real app's place: the dev build has its own bundle id, settings and cookies
    guard Bundle.main.bundleIdentifier == "app.cipherfilm.mac.dev" else { log("refusing: not the dev build"); return }
    let m = AppModel.shared
    let nav = DebugHooks.shared
    log("start")
    cleanTestDir()
    if env["CF_APPEARANCE"] == "dark" { NSApp.appearance = NSAppearance(named: .darkAqua) }
    _ = await wait("start") { m.phase != .starting }
    if m.phase == .noServer || m.server?.absoluteString != env["CF_TEST_SERVER"] {
      do { try await m.chooseServer(env["CF_TEST_SERVER"]!) } catch { check(false, "server: \(error)") }
    }
    try? await Task.sleep(nanoseconds: 800_000_000)
    snapshot("01-signin")
    if m.phase == .signedOut {
      do { try await m.login(email: env["CF_TEST_EMAIL"]!, password: env["CF_TEST_PASSWORD"]!) } catch { check(false, "login: \(error)") }
    } else if m.phase == .locked {
      do { try await m.unlock(password: env["CF_TEST_PASSWORD"]!) } catch { check(false, "unlock: \(error)") }
    }
    check(m.phase == .unlocked, "signed in and unlocked")
    // CF_SIGNIN_ONLY=1: only signs in and leaves the app open as it is, for trying it by hand against the test server
    if env["CF_SIGNIN_ONLY"] == "1" { log("DONE signed in"); return }
    // CF_INDEX_ONLY=1: turns search on (no faces) and waits until every photo is indexed, its entries on the server;
    // for preparing demo data
    if env["CF_INDEX_ONLY"] == "1" {
      m.settings.faces = false
      m.settings.indexOnBattery = true
      m.turnOnSearch(explicit: m.me?.user.nsfw == true ? false : nil)
      _ = await wait("search ready", timeout: 1800) { m.search.phase == .ready || m.search.phase == .error }
      check(m.search.phase == .ready, "indexed: \(m.search.index.count.items) items (\(m.search.message))")
      await m.signOut(deleteExport: false) // the next account signs in from scratch
      log("DONE \(failures) failed")
      return
    }
    m.agent.askNow = false
    m.settings.agentAsked = true
    m.settings.searchAsked = true
    _ = await wait("library") { !m.items.isEmpty }
    try? await Task.sleep(nanoseconds: 3_000_000_000)
    check(!m.items.isEmpty && m.items.allSatisfy { !$0.broken }, "library decrypted: \(m.items.count) items, \(m.items.filter(\.broken).count) broken")
    snapshot("02-library")
    if env["CF_SHOTS"] == "1" { await shots(); return }
    if env["CF_MAP"] == "1" { await mapChecks(); return }

    // ---- live updates: CF_LIVE_EXPECT photos uploaded by another device (a script that waits for LIVE READY) show
    // up without this Mac refreshing ----
    if let n = env["CF_LIVE_EXPECT"].flatMap(Int.init) {
      let before = m.items.count
      log("LIVE READY \(before)")
      let t0 = Date()
      let ok = await wait("live update", timeout: 120) { m.items.count >= before + n }
      check(ok, "\(n) photos uploaded elsewhere appear by themselves (\(m.items.count - before) after \(String(format: "%.1f", Date().timeIntervalSince(t0))) s)")
    }

    // ---- upload (drag and drop and the file picker both end in model.upload) ----
    let stamp = Int(Date().timeIntervalSince1970)
    if let dir = env["CF_TEST_DIR"] {
      let src = URL(fileURLWithPath: dir).appendingPathComponent("upload")
      let files = ((try? FileManager.default.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)) ?? []).filter { !$0.lastPathComponent.hasPrefix(".") }
      let tmp = URL(fileURLWithPath: dir).appendingPathComponent("up-\(stamp)")
      try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
      var names: [String] = []
      for f in files {
        let n = "mac-\(stamp)-\(f.lastPathComponent)"
        try? FileManager.default.copyItem(at: f, to: tmp.appendingPathComponent(n))
        names.append(n)
      }
      let before = m.items.count
      m.upload([tmp])
      _ = await wait("uploads", timeout: 180) { !m.uploads.isEmpty && m.uploads.allSatisfy { if case .waiting = $0.state { return false }; if case .running = $0.state { return false }; return true } }
      for u in m.uploads { if case .failed(let e) = u.state { log("upload failed \(u.name): \(e)") } }
      await m.refresh(quiet: true)
      let got = names.filter { n in m.items.contains { $0.name == n } }
      check(got.count == names.count && m.items.count >= before + names.count, "uploaded \(got.count)/\(names.count) files and they decrypt")
      for n in names {
        if let it = m.items.first(where: { $0.name == n }) { log("  \(n): \(it.kind) \(Int(it.meta?.width ?? 0))x\(Int(it.meta?.height ?? 0)) thumb \(it.hasThumb) preview \(it.hasPreview) gps \(it.meta?.gps.map { "\($0.lat),\($0.lon)" } ?? "none")") }
      }
      // what the Mac uploaded must decrypt byte for byte
      if let n = names.first, let it = m.items.first(where: { $0.name == n }), let v = m.vault {
        let out = tmp.appendingPathComponent("roundtrip")
        try? await v.saveOriginal(it, to: out)
        check(FileManager.default.contentsEqual(atPath: out.path, andPath: tmp.appendingPathComponent(n).path), "original round-trips byte for byte")
      }
    }

    // ---- thumbnails in batches ----
    if let v = m.vault {
      if let dir = v.cacheDir { for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where f.lastPathComponent.hasPrefix("thumb-") { try? FileManager.default.removeItem(at: f) } }
      let want = Array(m.items.filter(\.hasThumb).prefix(80))
      let t0 = Date()
      let got = (try? await v.thumbnails(want)) ?? [:]
      check(got.count == want.count, "\(got.count)/\(want.count) thumbnails in one batch request (\(Int(Date().timeIntervalSince(t0) * 1000)) ms)")
    }

    // ---- saving an original into a place picked in a panel (written via the staging folder) ----
    if let dir = env["CF_TEST_DIR"], let it = m.items.first(where: { $0.kind == .image }), let v = m.vault {
      let dest = URL(fileURLWithPath: dir).appendingPathComponent("saved-\(stamp)-\(it.name)")
      do {
        try await v.saveOriginal(it, to: dest, staging: Outbox.dir.appendingPathComponent("staging"))
        let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value
        check(size == it.size, "Save Original writes the whole file (\(size ?? -1) bytes)")
      } catch { check(false, "save original: \(error)") }
    }

    // ---- a file dropped from an app that hands over only a temporary copy ----
    if let dir = env["CF_TEST_DIR"], let f = ((try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: dir).appendingPathComponent("upload"), includingPropertiesForKeys: nil)) ?? []).first(where: { Media.isMedia($0) }) {
      let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("dropped-\(stamp)-\(f.lastPathComponent)")
      try? FileManager.default.copyItem(at: f, to: tmp)
      let kept = AppModel.Inbox.keep(tmp)
      try? FileManager.default.removeItem(at: tmp) // the app that dropped it deletes its copy
      check(kept.path.hasPrefix(AppModel.Inbox.dir.path), "a temporary dropped file is copied into the inbox")
      m.upload([kept])
      _ = await wait("dropped upload", timeout: 120) { m.items.contains { $0.name == "dropped-\(stamp)-\(f.lastPathComponent)" } }
      check(m.items.contains { $0.name == "dropped-\(stamp)-\(f.lastPathComponent)" }, "the dropped file uploaded after its temporary copy was gone")
      check(!FileManager.default.fileExists(atPath: kept.path), "the inbox copy is deleted after the upload")
    }

    // ---- viewer: a photo, then a video ----
    if let img = m.items.first(where: { $0.kind == .image && $0.hasPreview }) {
      nav.open?(img.id)
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      snapshot("03-viewer-photo")
      if let v = m.vault { check(await m.images.original(img, v) != nil, "original photo decodes for the viewer") }
    }
    if let vid = m.items.first(where: { $0.kind == .video }), let v = m.vault {
      let loader = VideoLoader(item: vid, vault: v)
      let asset = loader.asset()
      let playable = (try? await asset.load(.isPlayable)) ?? false
      let dur = (try? await asset.load(.duration))?.seconds ?? 0
      check(playable && dur > 0, "video streams through the decrypting loader (\(String(format: "%.1f", dur)) s)")
      nav.open?(vid.id)
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      snapshot("04-viewer-video")
      loader.close()
    }
    nav.close?()

    // ---- favorites, albums, trash ----
    if let it = m.items.first(where: { !$0.favorite }) {
      m.setFavorite([it.id], true)
      try? await Task.sleep(nanoseconds: 1_500_000_000); await m.refresh(quiet: true)
      check(m.item(it.id)?.favorite == true, "favorite set on the server")
      m.setFavorite([it.id], false)
    }
    if let v = m.vault, let it = m.items.first {
      do {
        let a = try await v.createAlbum("Mac test \(stamp)")
        try await v.addToAlbum(a.id, [it.id])
        await m.refresh(quiet: true)
        check(m.albums.contains { $0.name == "Mac test \(stamp)" && $0.itemIds.contains(it.id) }, "album created with its encrypted name")
        nav.go?(.album(a.id)); try? await Task.sleep(nanoseconds: 1_500_000_000); snapshot("05-album")
        _ = try await v.renameAlbum(a.id, "Mac test renamed \(stamp)")
        try await v.deleteAlbum(a.id)
      } catch { check(false, "albums: \(error)") }
    }

    // ---- search and people (with CF_FRESH_MODELS=1 the models are downloaded again, through whatever CF_TEST_SERVER is:
    // a slow or interrupting proxy tests the resumable download) ----
    if env["CF_FRESH_MODELS"] == "1" { m.search.models.delete() }
    m.settings.faces = true
    m.settings.indexOnBattery = true
    m.turnOnSearch()
    // nothing is downloaded before the yes (docs/MODELS.md): with fresh models search waits for it; then the driver
    // gives it, as the person would in the question
    _ = await wait("search starts", timeout: 120) { m.search.phase != .off && m.search.phase != .loading }
    if env["CF_FRESH_MODELS"] == "1" { check(m.search.phase == .consent, "search waits for the yes before downloading the models") }
    if m.search.phase == .consent { m.search.agree(m.search.pendingAsk()) }
    let tIndex = Date()
    var sawError: String?, retries = 0, sawRate = 0.0, lastRetry = false, reasons: [String] = []
    _ = await wait("search ready", timeout: 1800) {
      let s = m.search
      if s.phase == .error, sawError == nil { sawError = s.message }
      if s.phase == .download {
        sawRate = max(sawRate, s.rate)
        if let why = s.retry, !lastRetry { retries += 1; if !reasons.contains(why.reason) { reasons.append(why.reason) } }
        lastRetry = s.retry != nil
      }
      return s.phase == .ready
    }
    // the account may be indexed by another device (a phone signed in to it too): this Mac takes over, as the person
    // would in Settings › Search & People, so the checks below run against this Mac's own index
    if !m.search.indexes, let api = m.api {
      log("another device indexes this account (\(m.me?.indexer ?? "-")): this Mac takes over")
      do { try await takeOverIndexing(api) } catch { check(false, "take over indexing: \(error)") }
    }
    log("model download: \(retries) drops resumed, top speed \(bytes(Int64(sawRate)))/s, said: \(reasons.joined(separator: " | "))")
    check(sawError == nil, "search came up without an error on the way\(sawError.map { ": " + $0 } ?? "")")
    check(!Models.oldFiles.contains { FileManager.default.fileExists(atPath: m.search.models.dir.appendingPathComponent($0.old).path) },
          "no file of an earlier model left (MobileCLIP's deleted, LAION's under the new names)")
    log("indexing took \(Int(Date().timeIntervalSince(tIndex))) s for \(m.search.index.count.items) items (from the server's entries plus new ones)")
    check(m.search.phase == .ready, "search index ready: \(m.search.index.count.items) items, \(m.search.index.count.faces) faces")
    let r = await m.search.search("person", library: m.items)
    log("search 'person': \(r.items.count) items")
    check(r.items.count <= m.search.index.count.items && !r.items.isEmpty, "search ranks the indexed photos, no cut-off besides the explicit-content filter (\(r.items.count) of \(m.search.index.count.items))")
    let r2 = await m.search.search(m.items.first(where: { $0.kind == .video }) != nil ? "videos" : "2026", library: m.items)
    check(!r2.items.isEmpty, "search by kind/date works (\(r2.items.count))")
    if let first = m.items.first(where: { m.search.index.has($0.id) }) {
      let sim = m.search.similar(to: first.id)
      log("similar to \(first.name): \(sim.count)")
      nav.go?(.similar(first.id)); try? await Task.sleep(nanoseconds: 1_500_000_000); snapshot("06-similar")
    }
    nav.query?("beach"); try? await Task.sleep(nanoseconds: 2_500_000_000); snapshot("07-search"); nav.query?("")
    var groups = await m.search.peopleGroups()
    log("people groups: \(groups.count) \(groups.map { "\($0.name.isEmpty ? "?" : $0.name):\($0.items.count)" })")
    if let g = groups.first(where: { $0.person == nil }) ?? groups.first {
      do {
        let name = "Testperson \(stamp % 1000)"
        _ = try await m.search.name(g, name)
        try await m.search.loadPeople()
        groups = await m.search.peopleGroups()
        check(groups.contains { $0.name == name }, "person named; the encrypted people document saved and read back")
        if let named = groups.first(where: { $0.name == name }) {
          try await m.search.setHidden(named, true)
          try await m.search.setHidden(named, false)
          check(true, "hide and show a person")
          // renaming an already named person
          try await m.search.name(named, name + " B")
          groups = await m.search.peopleGroups()
          check(groups.contains { $0.name == name + " B" } && !groups.contains { $0.name == name }, "a named person renamed")
        }
        // naming from the viewer's info: the faces in one photo
        if let it = m.items.first(where: { !m.search.index.facesOf($0.id).isEmpty }) {
          let fs = await m.search.facesIn(it.id)
          check(!fs.isEmpty && fs.allSatisfy { $0.group != nil }, "info lists the photo's faces with their groups (\(fs.count))")
          nav.open?(it.id); try? await Task.sleep(nanoseconds: 2_500_000_000); snapshot("13-viewer-info"); nav.close?()
        }
      } catch { check(false, "people: \(error)") }
    } else {
      log("no face groups in the test library")
    }
    nav.go?(.people); try? await Task.sleep(nanoseconds: 2_000_000_000); snapshot("08-people")

    // ---- continuous export ----
    if let dir = env["CF_TEST_DIR"] {
      let ex = URL(fileURLWithPath: dir).appendingPathComponent("export-\(stamp)")
      try? FileManager.default.createDirectory(at: ex, withIntermediateDirectories: true)
      m.settings.exportPath = ex.path
      m.settings.exportOn = true
      _ = await wait("export", timeout: 600) { m.exporter.phase == .idle }
      func exported() -> [String] { (FileManager.default.enumerator(atPath: ex.path)?.allObjects as? [String] ?? []).filter { !$0.hasPrefix(".") && !$0.contains("/.") && $0.contains(".") && !$0.hasSuffix(".part") } }
      let unique = Set(m.items.filter { !$0.broken }.map { Crypto.fingerprint(name: $0.name, size: $0.size) }).count
      var files = exported()
      check(m.exporter.phase == .idle && files.count == unique, "export wrote \(files.count) files for \(m.items.count) items (\(unique) different; duplicates share one file)")
      check(!files.contains { $0.contains(" (2).") && m.items.filter { !$0.broken }.count == unique }, "no “(2)” copies")
      // the list of what was written is lost: the files already there are adopted, nothing is written twice
      try? FileManager.default.removeItem(at: AccountFile<Exporter.Manifest>(userId: m.me!.user.id, name: "export.json").url)
      m.exporter.exportNow()
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      _ = await wait("export again", timeout: 300) { m.exporter.phase == .idle }
      check(exported().count == files.count, "a lost export list doesn't duplicate files (\(exported().count))")
      // by album: the files move, there are still as many
      m.settings.exportLayout = .album
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      _ = await wait("export by album", timeout: 300) { m.exporter.phase == .idle }
      files = exported()
      check(files.count == unique && files.contains { $0.hasPrefix("Not in an album/") }, "by-album layout moved the files, no copies (\(files.count))")
      snapshotFolder(ex)
      m.settings.exportLayout = .month
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      _ = await wait("export by month", timeout: 300) { m.exporter.phase == .idle }
      check(exported().count == unique, "back to months, still no copies")
      // keep up to date off: nothing happens by itself; Export Now does a pass
      m.settings.exportKeepUpToDate = false
      check(m.exporter.phase == .idle, "keep up to date off: idle until Export Now")
      m.settings.exportKeepUpToDate = true
      // trash one in the library: its unchanged copy goes to the macOS Trash; restore: it comes back
      if let it = m.items.first(where: { $0.name.hasPrefix("mac-\(stamp)") }) {
        let man = AccountFile<Exporter.Manifest>(userId: m.me!.user.id, name: "export.json").read()
        let rel = man?.entries[it.id]?.path ?? ""
        m.moveToTrash([it.id])
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        _ = await wait("export after trash") { m.exporter.phase == .idle }
        check(!rel.isEmpty && !FileManager.default.fileExists(atPath: ex.appendingPathComponent(rel).path), "trashed item's copy left the export folder")
        m.restore([it.id])
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        _ = await wait("export after restore") { m.exporter.phase == .idle }
        let man2 = AccountFile<Exporter.Manifest>(userId: m.me!.user.id, name: "export.json").read()
        check(man2?.entries[it.id].map { FileManager.default.fileExists(atPath: ex.appendingPathComponent($0.path).path) } == true, "restored item exported again")
      }
      m.settings.exportOn = false
    }

    // ---- watched folders: new files upload (sealed item keys), duplicates are skipped, also while locked ----
    if let dir = env["CF_TEST_DIR"], let v = m.vault {
      let watch = URL(fileURLWithPath: dir).appendingPathComponent("watch-\(stamp)")
      try? FileManager.default.createDirectory(at: watch, withIntermediateDirectories: true)
      let src = URL(fileURLWithPath: dir).appendingPathComponent("upload")
      let pool = ((try? FileManager.default.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)) ?? []).filter { Media.isMedia($0) }
      do {
        m.settings.pubkey = B64.encode(try v.checkedPublicKey())
        m.settings.watched = [WatchedFolder(path: watch.path, baselineDone: true)]
        m.settings.watchOn = true
        // a duplicate of something the library has (same name and size) must be skipped
        let dupe = m.items.first(where: { $0.name.hasPrefix("mac-\(stamp)") })
        if let dupe, let srcFile = pool.first(where: { dupe.name.hasSuffix($0.lastPathComponent) }) {
          try FileManager.default.copyItem(at: srcFile, to: watch.appendingPathComponent(dupe.name))
        }
        if let f = pool.first {
          try FileManager.default.copyItem(at: f, to: watch.appendingPathComponent("watched-\(stamp)-\(f.lastPathComponent)"))
        }
        _ = await wait("watched upload", timeout: 120) { m.items.contains { $0.name.hasPrefix("watched-\(stamp)") } }
        let it = m.items.first { $0.name.hasPrefix("watched-\(stamp)") }
        check(it != nil && !(it!.broken), "watched folder: new file uploaded with a sealed key and it decrypts")
        // by name, not by count: other test clients may upload to the same account meanwhile
        check(dupe.map { d in m.items.filter { $0.name == d.name }.count == 1 } ?? false, "watched folder: the duplicate was skipped")
        // locked: still uploads
        m.lock()
        if let f = pool.dropFirst().first ?? pool.first {
          try FileManager.default.copyItem(at: f, to: watch.appendingPathComponent("locked-\(stamp)-\(f.lastPathComponent)"))
        }
        _ = await wait("watcher idle", timeout: 30) { !m.watcher.running && m.watcher.uploaded >= 2 }
        _ = await wait("locked upload", timeout: 90) { m.watcher.uploaded >= 2 && !m.watcher.running }
        check(m.watcher.uploaded >= 2, "watched folder uploads while the library is locked (\(m.watcher.uploaded))")
        snapshot("09-locked")
        try await m.unlock(password: env["CF_TEST_PASSWORD"]!)
        _ = await wait("library after unlock") { m.items.contains { $0.name.hasPrefix("locked-\(stamp)") } }
        check(m.items.contains { $0.name.hasPrefix("locked-\(stamp)") }, "file uploaded while locked is in the library after unlocking")
        m.settings.watchOn = false
      } catch { check(false, "watched folders: \(error)") }
    }
    // ---- the upload queue survives: saved, restored, retried ----
    if let dir = env["CF_TEST_DIR"], let f = ((try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: dir).appendingPathComponent("upload"), includingPropertiesForKeys: nil)) ?? []).first {
      m.uploadsPaused = true
      let q = URL(fileURLWithPath: dir).appendingPathComponent("queue-\(stamp)")
      try? FileManager.default.createDirectory(at: q, withIntermediateDirectories: true)
      try? FileManager.default.copyItem(at: f, to: q.appendingPathComponent("queued-\(stamp)-\(f.lastPathComponent)"))
      m.upload([q])
      m.upload([q]) // twice: queued once
      let saved = AccountFile<[UploadJob]>(userId: m.me!.user.id, name: "uploads.json").read() ?? []
      check(saved.filter { $0.name.hasPrefix("queued-\(stamp)") }.count == 1, "upload queue saved on disk, same file queued once")
      m.uploadsPaused = false
      _ = await wait("queued upload", timeout: 120) { m.items.contains { $0.name.hasPrefix("queued-\(stamp)") } }
      check(m.items.contains { $0.name.hasPrefix("queued-\(stamp)") }, "paused queue resumes and uploads")
    }

    // ---- moving faces between people ----
    let gs = await m.search.peopleGroups()
    if let from = gs.first(where: { $0.person != nil && $0.faces.count >= 2 }) {
      let faces = m.search.faces(of: from)
      check(faces.count == from.faces.count, "face strip has every face of the person (\(faces.count))")
      do {
        let k = faces.last!.key
        try await m.search.move(faces: [k], from: from, to: nil, newName: "Moved \(stamp % 1000)")
        let after = await m.search.peopleGroups()
        let moved = after.first { $0.name == "Moved \(stamp % 1000)" }
        check(moved?.faces.contains(k) == true && after.first(where: { $0.key == from.key })?.faces.contains(k) == false, "a face moved to a new person and left the old one")
        if let moved, let back = after.first(where: { $0.key == from.key })?.person {
          try await m.search.move(faces: [k], from: moved, to: back)
          try await m.search.forget(moved.person!)
        }
      } catch { check(false, "move faces: \(error)") }
      nav.go?(.person(from.key)); try? await Task.sleep(nanoseconds: 2_000_000_000); snapshot("11-person")
    }

    // ---- leaving the app: drag and Share decrypt into the private outbox, a lock empties it ----
    if let it = m.items.first(where: { $0.kind == .image }), let v = m.vault {
      let u = try? await Outbox.file(it, v)
      check(u.map { FileManager.default.fileExists(atPath: $0.path) } == true, "share/drag file decrypted into the outbox")
      m.lock()
      check(!FileManager.default.fileExists(atPath: Outbox.dir.path), "lock empties the outbox")
      try? await m.unlock(password: env["CF_TEST_PASSWORD"]!)
      _ = await wait("unlock") { !m.items.isEmpty }
    }
    if let dirS = env["CF_SNAPSHOTS"], let png = MenuBarIcon.image(busy: true).tiffRepresentation.flatMap({ NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }) {
      try? png.write(to: URL(fileURLWithPath: dirS).appendingPathComponent("menubar-icon.png"))
    }
    nav.go?(.photos); try? await Task.sleep(nanoseconds: 1_500_000_000); snapshot("10-photos")
    nav.jump?(Calendar.current.date(byAdding: .day, value: -1, to: Date())!); try? await Task.sleep(nanoseconds: 1_500_000_000); snapshot("12-jump")
    // ---- explicit search: allowed by the admin (the test account is one), turned on, and off again ----
    if env["CF_TEST_EXPLICIT"] == "1", let me = m.me, let api = m.api {
      let wasAllowed = me.user.nsfw == true // the test server is shared: left as found
      do {
        try await api.json("PATCH", "/api/admin/users/\(me.user.id)", body: ["nsfw": true])
        m.me = try JSONDecoder().decode(Me.self, from: try await api.json("GET", "/api/me"))
        check(m.me?.user.nsfw == true, "explicit search allowed by the admin")
        try await m.search.setExplicit(true)
        check(!m.search.filtered && m.search.phase == .ready, "explicit on: search unfiltered, nothing indexed again")
        let (people0, _) = try await People.load(m.vault!)
        check(people0.explicit == true, "the choice is in the encrypted people document")
        let hits = await m.search.textHits("a man in a suit")
        log("'a man in a suit' unfiltered: \(hits.count) hits, best \(hits.first.map { String(format: "%.3f", $0.score) } ?? "-")")
        check(!hits.isEmpty && hits.count == m.search.index.count.items && zip(hits, hits.dropFirst()).allSatisfy { $0.score >= $1.score },
              "unfiltered search ranks every indexed photo, best first, no cut-off (\(hits.count))")
        let blocked = await m.search.textHits("nude")
        check(blocked.count == m.search.index.count.items, "unfiltered: explicit words search as any others")
        try await m.search.setExplicit(false)
        check(m.search.filtered, "explicit off: filtered again")
        check(await m.search.textHits("nude").isEmpty, "filtered: explicit words find nothing")
        try await api.json("PATCH", "/api/admin/users/\(me.user.id)", body: ["nsfw": wasAllowed])
        m.me = try JSONDecoder().decode(Me.self, from: try await api.json("GET", "/api/me"))
      } catch { check(false, "explicit search: \(error)") }
    }

    // ---- sign out and back in ----
    let count = m.items.count
    // a paused upload waits in the queue while signing out
    let waiting = FileManager.default.temporaryDirectory.appendingPathComponent("cf-not-uploaded-\(UUID().uuidString).txt")
    try? Data("x".utf8).write(to: waiting)
    m.uploadsPaused = true
    m.upload([waiting])
    let queued = m.uploads.count
    await m.signOut(deleteExport: false)
    try? FileManager.default.removeItem(at: waiting)
    check(m.phase == .signedOut && m.items.isEmpty && m.vault == nil, "signed out: nothing of the account left in memory")
    check(queued == 1 && m.uploads.isEmpty && !m.uploadsPaused, "signed out: the upload queue is gone too (it never goes on in another account)")
    do {
      try await m.login(email: env["CF_TEST_EMAIL"]!, password: env["CF_TEST_PASSWORD"]!)
      if m.phase == .locked { try await m.unlock(password: env["CF_TEST_PASSWORD"]!) }
      _ = await wait("library after signing in again") { m.items.count >= count }
      check(m.phase == .unlocked && m.items.count >= count, "signed in again: \(m.items.count) items")
    } catch { check(false, "sign in again: \(error)") }

    // ---- one device indexes; a second device (its own cookies) takes over, this Mac only reads; then it signs this
    // Mac out, which forgets the account here (docs/SEARCH.md, "One device indexes", "Devices") ----
    if let api = m.api, let server = m.server {
      let other = API(base: server, cookies: HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: "cftest-second-device"))
      do {
        m.settings.search = true
        _ = await wait("search ready again", timeout: 600) { m.search.phase == .ready }
        m.me = try JSONDecoder().decode(Me.self, from: try await api.json("GET", "/api/me"))
        let mine = m.me?.session_id ?? ""
        // another device of the account may have taken the role meanwhile (a phone signed in to it too): taken back
        if let ix = m.me?.indexer, !ix.isEmpty, ix != mine {
          log("another device indexes this account (\(ix)): this Mac takes over")
          try await takeOverIndexing(api)
        }
        // after signing in again this is a new session: it is the indexer once it writes, or none is set yet
        check(!mine.isEmpty && (m.me?.indexer == mine || m.me?.indexer == "") && m.search.indexes, "this Mac may index (indexer: \(m.me?.indexer ?? "-"))")
        struct Sessions: Decodable { let sessions: [SearchEngine.Device] }
        let list = try await api.get(Sessions.self, "/api/me/sessions").sessions
        check(list.first { $0.current }?.device == API.device, "the device list names this Mac as it said at sign-in (\(list.first { $0.current }?.device ?? "-"))")
        _ = try await Account.login(api: other, email: env["CF_TEST_EMAIL"]!, password: env["CF_TEST_PASSWORD"]!)
        try await other.json("PUT", "/api/me/indexer")
        _ = await wait("this Mac becomes a reader", timeout: 180) { !m.search.indexes && m.search.phase == .ready }
        let dir = m.search.models.dir
        func has(_ f: ModelFile) -> Bool { FileManager.default.fileExists(atPath: dir.appendingPathComponent(f.name).path) }
        check(!m.search.indexes && !has(ClipModel.clip.vision) && !Models.faceFiles.contains(where: has) && has(ClipModel.clip.text) && has(Models.tokenizer),
              "another device indexes: this Mac only reads and keeps just the text model and the tokenizer")
        let hits = await m.search.textHits("person")
        check(!hits.isEmpty && hits.count <= m.search.index.count.items, "a reading Mac still searches the indexed photos (\(hits.count))")
        do {
          // a well-formed body (the server checks the format first); refused before it is stored
          try await SearchEngine.put(B64.encode(Data(count: 1100)), model: ClipModel.clip.tag, item: m.items[0].id, api: api)
          check(false, "a reading Mac's index write is refused")
        } catch let e as APIError { check(e.status == 409 && e.code == "not_indexer", "a reading Mac's index write is refused with not_indexer (\(e.status) \(e.code ?? e.message))") }
        let shown = await m.search.indexingDevice(api: api)
        check(shown != nil && shown?.current == false, "settings name the other device as the indexing one")
        let before = try await api.get(Page.self, "/api/index?model=laionb32").entries.count
        do { try await other.json("DELETE", "/api/index?model=laionb32"); check(false, "an older app's request to delete the index by family is refused") }
        catch let e as APIError { check(e.status == 409, "an older app's request to delete the index by family is refused (\(e.status))") }
        check(try await api.get(Page.self, "/api/index?model=laionb32").entries.count == before && before > 0, "the index stays (\(before))")
        // its image models went when it became a reader, and the yes with them: taking over asks again first
        let asked = try await takeOverIndexing(api)
        check(asked, "Index on This Mac Instead asks before downloading the image models again")
        check(m.search.indexes && has(ClipModel.clip.vision) && m.me?.indexer == mine, "Index on This Mac Instead: the image models are back and this Mac indexes")
        // signed out from the other device: the next request gets 401 and nothing of the account stays here
        let userId = m.me!.user.id
        try await other.json("DELETE", "/api/me/sessions/\(mine)")
        await m.refresh(quiet: true)
        _ = await wait("signed out by the other device") { m.phase == .signedOut }
        check(m.phase == .signedOut && m.vault == nil && !FileManager.default.fileExists(atPath: Paths.account(userId).path)
              && !FileManager.default.fileExists(atPath: Vault.cacheRoot().appendingPathComponent(userId).path),
              "signed out from another device: the account's settings and caches are gone from this Mac")
        check(m.notice == "This Mac was signed out from another device.", "it says it was signed out from another device (\(m.notice ?? "-"))")
        // the same when the app starts after it happened
        try FileManager.default.createDirectory(at: Paths.account(userId), withIntermediateDirectories: true)
        await m.start()
        check(m.phase == .signedOut && !FileManager.default.fileExists(atPath: Paths.account(userId).path), "a session ended while the app was closed is forgotten at the start")
      } catch { check(false, "one device indexes: \(error)") }
      _ = try? await other.json("POST", "/api/auth/logout")
      other.clearCookies()
    }

    if env["CF_KEEP"] != "1" {
      m.settings.watchOn = false; m.settings.exportOn = false // nothing writes into the folders while they go
      cleanTestDir()
    }
    log(failures == 0 ? "DONE all passed" : "DONE \(failures) failed")
    if env["CF_AUTOTEST_QUIT"] == "1" { AppDelegate.quitting = true; NSApp.terminate(nil) }
  }

  /** CF_MAP=1: the map tab, place names and search by place, against an account whose photos carry coordinates
   *  (30 located: Zürich 5, Lucerne 3, Paris 6, London 3, New York 4, Tokyo 4, Sydney 2, Cape Town 2, Reykjavik 1). */
  static func mapChecks() async {
    let m = AppModel.shared
    let nav = DebugHooks.shared
    func pause(_ s: Double = 1.5) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
    func near(_ it: Item, _ lat: Double, _ lon: Double, _ d: Double = 0.6) -> Bool { it.location.map { abs($0.lat - lat) < d && abs($0.lon - lon) < d } ?? false }
    if let api = m.api, let raw = try? await api.json("GET", "/api/me"), let o = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] {
      check(o["map"] != nil && m.me?.hasMap == true, "the Map entry is there: /api/me names the map's styles (\(m.me?.map?.light.first ?? "-"))")
    } else { check(false, "/api/me") }
    let located = m.items.filter { $0.location != nil }
    check(located.count == 30, "located photos: \(located.count) of \(m.items.count) items")
    check(PlaceBook.places != nil, "the place names file is in the app (\(PlaceBook.places?.count ?? 0) places)")
    if let z = located.first(where: { near($0, 47.37, 8.54, 0.1) }), let g = z.location {
      let name = await PlaceBook.label(g)
      check(name == "Zürich, Switzerland", "place of a Zürich photo: \(name ?? "-")")
    } else { check(false, "a photo in Zürich") }
    // the place hits come first; on an account with a search index the rest of the library follows, ranked
    let tokyo = Set(located.filter { near($0, 35.68, 139.7) }.map(\.id))
    for q in ["japan", "Japan", "Tokyo"] {
      let r = await m.search.search(q, library: m.items)
      check(Set(r.items.prefix(tokyo.count).map(\.id)) == tokyo && tokyo.count == 4, "search “\(q)” finds the \(tokyo.count) Tokyo photos (\(r.items.count): \(r.how.joined(separator: ", ")))")
    }
    let zurich = Set(located.filter { near($0, 47.37, 8.54, 0.1) }.map(\.id))
    for q in ["zurich", "Zürich"] {
      let r = await m.search.search(q, library: m.items)
      check(Set(r.items.prefix(zurich.count).map(\.id)) == zurich && zurich.count == 5, "search “\(q)” finds the \(zurich.count) Zürich photos (\(r.items.count))")
    }
    let swiss = await m.search.search("switzerland", library: m.items)
    let swissIds = Set(located.filter { near($0, 47.37, 8.54, 0.1) || near($0, 47.05, 8.31, 0.1) }.map(\.id))
    check(swissIds.count == 8 && Set(swiss.items.prefix(8).map(\.id)) == swissIds, "search “switzerland” finds Zürich and Lucerne first (\(swiss.items.count))")

    // the map is off until the person turns it on: the tab asks first, and no web view (no map image) exists
    m.mapOn = false
    let tokyoPhoto = located.first(where: { near($0, 35.68, 139.7) })
    nav.go?(.map)
    await pause(2)
    check(nav.map == nil, "map off by default: the tab shows the question, no map web view")
    snapshot("map-00-consent")
    // the same screen drawn without the window (a window snapshot draws only half of it while the display is off)
    if let dir = env["CF_SNAPSHOTS"] {
      let r = ImageRenderer(content: MapConsent(styles: m.me?.map, turnOn: {}).frame(width: 1000, height: 640).background(Ink.paper))
      r.scale = 2
      if let cg = r.cgImage { try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("map-00-consent-rendered.png")) }
    }
    if let z = tokyoPhoto {
      nav.open?(z.id); await pause(2)
      check(nav.mini == nil, "map off: no small map in the photo's details")
      snapshot("map-00-viewer-info-off")
      nav.close?(); await pause(0.5)
    }
    // turned on (the tab's button): the base map's style loads, the photos are drawn as clustered markers
    m.mapOn = true
    let styled = await wait("map style", timeout: 45) { nav.map?.styleLoaded == true || nav.map?.failed == true }
    check(styled && nav.map?.styleLoaded == true, "the map's page loads its base map style")
    let drawn = await wait("map markers", timeout: 20) { (nav.map?.markers ?? 0) > 0 }
    check(drawn, "the map draws cluster markers (\(nav.map?.markers ?? 0))")
    await pause(3) // tiles and thumbnails
    snapshot("map-01-home")
    if let c = nav.map {
      let ids = await c.inView()
      check(!ids.isEmpty && ids.count < 30, "the map opens on the area with the most photos, not the whole world (\(ids.count) of 30)")
      c.onPhotos?(located.filter { near($0, 48.86, 2.35) }.map(\.id))
      await pause(2.5)
      snapshot("map-02-panel")
    }
    // the viewer's details: the place name over the coordinates, and the small map
    if let z = tokyoPhoto {
      nav.open?(z.id)
      let mini = await wait("small map", timeout: 30) { nav.mini?.styleLoaded == true }
      check(mini, "the small map in the photo's details loads")
      await pause(2.5)
      snapshot("map-03-viewer-info")
      // turned off in Settings while the details are open: the small map goes at once
      m.mapOn = false
      let gone = await wait("small map gone", timeout: 5) { nav.mini == nil }
      check(gone, "map turned off: the small map is gone from the photo's details")
      nav.close?()
    }
    let mapGone = await wait("map gone", timeout: 5) { nav.map == nil }
    check(mapGone, "map turned off: the map tab's web view is gone, the question is back")
    snapshot("map-04-off-again")
    // signed out again: the next run starts from the sign-in, and no session of the test account is left here
    await m.signOut(deleteExport: false)
    check(m.phase == .signedOut, "signed out at the end")
    log(failures == 0 ? "DONE all passed" : "DONE \(failures) failed")
    if env["CF_AUTOTEST_QUIT"] == "1" { AppDelegate.quitting = true; NSApp.terminate(nil) }
  }

  /** CF_SHOTS=1: only look, change nothing on the server. Snapshots of the main screens for design reviews. */
  static func shots() async {
    let m = AppModel.shared
    let nav = DebugHooks.shared
    func pause(_ s: Double = 1.5) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
    nav.go?(.albums); await pause(); snapshot("03-albums")
    nav.go?(.people); await pause(2); snapshot("04-people")
    nav.go?(.trash); await pause(); snapshot("05-trash")
    nav.go?(.photos); await pause()
    nav.query?("2026"); await pause(2); snapshot("06-search"); nav.query?("")
    if let it = m.items.first(where: { $0.kind == .image }) {
      nav.open?(it.id); await pause(2.5); snapshot("07-viewer"); nav.close?()
    }
    log("DONE shots")
    if env["CF_AUTOTEST_QUIT"] == "1" { AppDelegate.quitting = true; NSApp.terminate(nil) }
  }
}

/** The driver reaches the window's navigation through these. */
@MainActor
final class DebugHooks {
  static let shared = DebugHooks()
  var open: ((String) -> Void)?
  var close: (() -> Void)?
  var go: ((Screen) -> Void)?
  var query: ((String) -> Void)?
  var jump: ((Date) -> Void)?
  /** the map tab's and the photo details' map pages, while they are shown */
  weak var map: MapController?
  weak var mini: MapController?
}
#endif
