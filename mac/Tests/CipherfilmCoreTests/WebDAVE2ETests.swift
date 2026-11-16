// End-to-end: a WebDAV folder imported into a throwaway Cipherfilm server (mac/scripts/webdav-e2e.sh starts both and
// the files; never a real instance). Skipped unless CF_WEBDAV_E2E is set. Measures the peak disk use of the import's
// temporary folder, the process's peak memory and the throughput, and writes them to CF_REPORT.
//   CF_WEBDAV_E2E=1 CF_URL CF_TEST_CA CF_EMAIL CF_PASSWORD CF_WEBDAV CF_WEBDAV_USER CF_WEBDAV_PASS CF_TEMP CF_REPORT
import Darwin
import Foundation
import Testing
@testable import CipherfilmCore

@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["CF_WEBDAV_E2E"] != nil))
struct WebDAVE2ETests {
  let env = ProcessInfo.processInfo.environment

  /** The process's memory as Activity Monitor counts it. */
  static func footprint() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
    return r == KERN_SUCCESS ? Int64(info.phys_footprint) : 0
  }

  static func size(of dir: URL) -> Int64 {
    guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) else { return 0 }
    var n: Int64 = 0
    while let u = e.nextObject() as? URL { n += Int64((try? u.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0) }
    return n
  }

  final class Peak: @unchecked Sendable {
    let lock = NSLock()
    var disk: Int64 = 0, memory: Int64 = 0
    func sample(_ dir: URL) {
      let d = WebDAVE2ETests.size(of: dir), m = WebDAVE2ETests.footprint()
      lock.withLock { disk = max(disk, d); memory = max(memory, m) }
    }
  }

  final class Flag: @unchecked Sendable {
    let lock = NSLock()
    var stop = false
    var uploaded = 0
  }

  @Test func importFolder() async throws {
    let jar = HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: "cftest-webdav")
    defer { for c in jar.cookies ?? [] { jar.deleteCookie(c) } }
    let api = API(base: URL(string: env["CF_URL"]!)!, cookies: jar)
    guard case .done(let me, let master) = try await Account.login(api: api, email: env["CF_EMAIL"]!, password: env["CF_PASSWORD"]!) else {
      Issue.record("no session"); return
    }
    let vault = Vault(api: api, me: me, masterKey: master)
    defer { if let d = Vault.cacheDir(of: me.user.id) { try? FileManager.default.removeItem(at: d) } } // the throwaway account's cache
    let pk = try vault.checkedPublicKey()
    let folder = URL(string: env["CF_WEBDAV"]!)!
    let temp = URL(fileURLWithPath: env["CF_TEMP"]!)
    try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    let client = WebDAVClient(folder: folder, user: env["CF_WEBDAV_USER"]!, password: env["CF_WEBDAV_PASS"]!)
    var report = ""

    // a wrong password is refused, not retried
    let wrong = WebDAVClient(folder: folder, user: env["CF_WEBDAV_USER"]!, password: "wrong")
    await #expect(throws: WebDAVError.unauthorized) { try await wrong.list() }
    // a server whose certificate macOS doesn't trust gets nothing
    if let bad = env["CF_WEBDAV_SELFSIGNED"] {
      let c = WebDAVClient(folder: URL(string: bad)!, user: env["CF_WEBDAV_USER"]!, password: env["CF_WEBDAV_PASS"]!)
      await #expect(throws: WebDAVError.certificate) { try await c.list() }
    }

    let listing = try await client.list()
    let bookFile = temp.deletingLastPathComponent().appendingPathComponent("book-\(UUID().uuidString).log")
    defer { try? FileManager.default.removeItem(at: bookFile) }
    let book = ImportBook(file: bookFile)
    let plan = WebDAVImport.plan(listing, book: book, known: [])
    report += "folder: \(plan.files) files, \(plan.todo.count) to import (\(plan.bytes / 1_000_000) MB), \(plan.unsupported.count) unsupported, \(plan.folders) subfolders\n"
    #expect(plan.folders == 1)
    #expect(plan.unsupported.contains("notes.txt"))

    let peak = Peak()
    let sampler = Task.detached { while !Task.isCancelled { peak.sample(temp); try? await Task.sleep(nanoseconds: 50_000_000) } }
    let base = Self.footprint()

    // 1: interrupted after some files, like a lock or sleep
    let flag = Flag()
    let interruptAt = min(40, plan.todo.count / 3)
    do {
      try await WebDAVImport.run(plan.todo, client: client, api: api, wrap: .sealed(pk: pk), book: book, parallel: 3, temp: temp,
                                 live: { if flag.lock.withLock({ flag.stop }) { throw Stopped() } }) { ev in
        if case .uploaded = ev { flag.lock.withLock { flag.uploaded += 1; if flag.uploaded >= interruptAt { flag.stop = true } } }
        if case .failed(let n, let why, _) = ev { Issue.record("failed: \(n): \(why)") }
      }
      Issue.record("not interrupted")
    } catch is Stopped {}
    let afterStop = ImportBook(file: bookFile).doneCount
    report += "interrupted after \(afterStop) files\n"
    #expect(afterStop >= interruptAt)

    // 2: resumed from the bookkeeping on disk: only the rest
    let resumed = ImportBook(file: bookFile)
    let rest = WebDAVImport.plan(try await client.list(), book: resumed, known: [])
    #expect(rest.todo.count == plan.todo.count - afterStop)
    let received0 = client.received.value
    let start = Date()
    let sent = Counter()
    try await WebDAVImport.run(rest.todo, client: client, api: api, wrap: .sealed(pk: pk), book: resumed, parallel: 3, temp: temp, live: {}) { ev in
      if case .bytes(let n) = ev { sent.add(n) }
      if case .failed(let n, let why, _) = ev { Issue.record("failed: \(n): \(why)") }
    }
    let secs = Date().timeIntervalSince(start)
    sampler.cancel()
    peak.sample(temp)
    let mb = Double(rest.bytes) / 1_000_000
    report += String(format: "resumed: %d files, %.0f MB in %.1f s = %.1f MB/s (%.1f files/s)\n", rest.todo.count, mb, secs, mb / secs, Double(rest.todo.count) / secs)
    report += String(format: "read from WebDAV: %.0f MB for %.0f MB of files (%.1f%% extra for thumbnails/metadata probes)\n",
                     Double(client.received.value - received0) / 1e6, mb, 100 * (Double(client.received.value - received0) / Double(max(1, rest.bytes)) - 1))
    report += String(format: "peak temporary disk use: %.1f MB; peak memory: %.0f MB (%.0f MB above the start)\n",
                     Double(peak.disk) / 1e6, Double(peak.memory) / 1e6, Double(peak.memory - base) / 1e6)
    #expect(Self.size(of: temp) == 0, "temporary files left behind")

    // 3: again with fresh bookkeeping: everything is already in the library
    let lib = try await vault.loadLibrary()
    let names = lib.compactMap(\.meta).map(\.name)
    #expect(names.count == plan.todo.count, "library holds \(names.count), want \(plan.todo.count)")
    #expect(Set(names).count == names.count, "a file was uploaded twice")
    let known = Set(lib.compactMap { $0.meta.map { Crypto.fingerprint(name: $0.name, size: $0.size) } })
    let again = WebDAVImport.plan(try await client.list(), book: ImportBook(file: nil), known: known)
    #expect(again.todo.isEmpty && again.inLibrary == plan.todo.count)

    // the metadata as for a local import
    let byName = Dictionary(lib.compactMap { it in it.meta.map { ($0.name, $0) } }, uniquingKeysWith: { a, _ in a })
    if let v = byName["big.mov"] {
      #expect(v.capture_ts == 1_623_751_200_000, "video date \(v.capture_ts)")
      #expect(abs((v.gps?.lat ?? 0) - 47.3769) < 1e-3 && abs((v.gps?.lon ?? 0) - 8.5417) < 1e-3, "video place \(String(describing: v.gps))")
      #expect((v.duration ?? 0) > 1 && v.width == 1920 && v.height == 1080)
      report += "big.mov: \(v.size / 1_000_000) MB, \(String(describing: v.duration)) s, date and place kept\n"
    } else { Issue.record("big.mov missing") }
    if let p = byName["IMG_0001.JPG"] {
      #expect(p.make == "TestCam" && p.gps != nil, "\(p)")
    } else { Issue.record("IMG_0001.JPG missing") }
    if let g = byName.first(where: { $0.key.hasPrefix("gen-0001") })?.value {
      #expect(g.capture_ts == 1_720_973_002_000, "exif date \(g.capture_ts)")
    }
    // a file without a date of its own takes the server's modification time
    if let s = byName["screen.png"], let e = listing.files.first(where: { $0.name == "screen.png" }), let m = e.modified {
      #expect(abs(s.capture_ts - m.timeIntervalSince1970 * 1000) < 1000)
    }
    print(report)
    if let r = env["CF_REPORT"] { try report.write(toFile: r, atomically: true, encoding: .utf8) }
  }
}
