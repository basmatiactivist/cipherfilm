// A lock or sign-out forgets the master key together with everything decrypted (AppModel.wipe): the parts that keep
// their own copy of the library let go of it too.
import Foundation
import Testing
@testable import Cipherfilm
@testable import CipherfilmCore

@MainActor @Suite struct LockForgetsTests {
  private func vault() throws -> Vault {
    let json = """
    {"user":{"id":"0123456789abcdef0123456789abcdef","email":"a@x.org","role":"user"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},
     "wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x"}
    """
    let me = try JSONDecoder().decode(Me.self, from: Data(json.utf8))
    return Vault(api: API(base: URL(string: "https://127.0.0.1:9")!), me: me, masterKey: Data(repeating: 1, count: 32))
  }

  @Test func theExporterLetsGoOfTheDecryptedLibrary() throws {
    let e = Exporter()
    let it = Item(id: "0123456789abcdef0123456789abcdef", kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true,
                  favorite: false, trashedAt: nil, purgeAt: nil, meta: nil, itemKey: Data(repeating: 7, count: 32), broken: false)
    let album = Album(id: "a", name: "Holidays", itemIds: [it.id], broken: false)
    e.libraryChanged(vault: try vault(), items: [it], albums: [album], settings: AccountSettings()) // no export folder: idle
    #expect(e.holdsLibrary)
    e.forget()
    #expect(!e.holdsLibrary)
    #expect(e.phase == .off)
  }

  @Test func theTripsLetGoOfTheDecryptedLibrary() async {
    let it = Item(id: "0123456789abcdef0123456789abcdef", kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true,
                  favorite: false, trashedAt: nil, purgeAt: nil, meta: ItemMeta(name: "a.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0, gps: GPS(lat: 47.4, lon: 8.5)), itemKey: nil, broken: false)
    await TripBook.shared.update([it])
    #expect(TripBook.shared.trips != nil)
    TripBook.shared.forget()
    #expect(TripBook.shared.trips == nil)
  }
}

/** Work that was in flight at a lock or sign-out keeps nothing and writes nothing back afterwards. */
@MainActor @Suite(.serialized) struct LateWorkTests {
  private func item(_ id: String) -> Item {
    Item(id: id, kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true, favorite: false, trashedAt: nil, purgeAt: nil,
         meta: ItemMeta(name: "a.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0, gps: GPS(lat: 47.4, lon: 8.5)), itemKey: nil, broken: false)
  }

  @Test func tripsWorkedOutBeforeALockAreDropped() async {
    let book = TripBook()
    let g = book.generation
    let t = Task { await book.update([item("0123456789abcdef0123456789abcdef")]) }
    while book.generation == g { await Task.yield() } // the update is waiting for its result
    book.forget()
    await t.value
    #expect(book.trips == nil)
  }

  @Test func aClosedVaultWritesNoCache() throws {
    let uid = String(format: "%032x", UInt64.random(in: 1...UInt64.max))
    let json = #"{"user":{"id":"\#(uid)","email":"a@x.org","role":"user"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},"wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x"}"#
    let me = try JSONDecoder().decode(Me.self, from: Data(json.utf8))
    let v = Vault(api: API(base: URL(string: "https://127.0.0.1:9")!), me: me, masterKey: Data(repeating: 1, count: 32))
    let dir = try #require(v.cacheDir)
    defer { try? FileManager.default.removeItem(at: dir) }
    v.close()
    v.keep("thumb-x", Data([1]))
    IndexCache(since: 1, entries: ["a": "b"]).write(v, "clip")
    #expect(!FileManager.default.fileExists(atPath: dir.path))
    // the account's small files: only while its folder is there
    AccountFile<[String]>(userId: uid, name: "late.json").writeIfPresent(["x"])
    #expect(!FileManager.default.fileExists(atPath: Paths.account(uid).path))
  }
}

/** A photo's small map loads only for the photo the person asked it for, not because the details column is open. */
@Suite struct MiniMapGateTests {
  @Test func onlyAfterShowMapForThatPhoto() {
    #expect(MiniMapGate.state(mapOn: true, serverMap: true, located: true, asked: nil, item: "a") == .offer)
    #expect(MiniMapGate.state(mapOn: true, serverMap: true, located: true, asked: "a", item: "a") == .show)
    // the next photo, with the column still open: asked again
    #expect(MiniMapGate.state(mapOn: true, serverMap: true, located: true, asked: "a", item: "b") == .offer)
    #expect(MiniMapGate.state(mapOn: false, serverMap: true, located: true, asked: "a", item: "a") == .mapOff)
    #expect(MiniMapGate.state(mapOn: true, serverMap: false, located: true, asked: "a", item: "a") == .none)
    #expect(MiniMapGate.state(mapOn: true, serverMap: true, located: false, asked: "a", item: "a") == .none)
  }
}

/** Writing list.json takes the vault's lock and checks the key under it: it must finish, never wait on itself
 *  (2.8.0 hung the app for good here after a sync that changed the list). */
@Suite(.serialized) struct ListWriteTests {
  /** waits on a thread of its own, so a hang fails the test instead of blocking the test runner */
  private func finishes(_ t: Task<Void, Never>) -> Bool {
    let done = DispatchSemaphore(value: 0)
    Task.detached { await t.value; done.signal() }
    return done.wait(timeout: .now() + 10) == .success
  }

  @Test func writingTheListNeverHangs() throws {
    let uid = String(format: "%032x", UInt64.random(in: 1...UInt64.max))
    let json = #"{"user":{"id":"\#(uid)","email":"a@x.org","role":"user"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},"wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x"}"#
    let me = try JSONDecoder().decode(Me.self, from: Data(json.utf8))
    let v = Vault(api: API(base: URL(string: "https://127.0.0.1:9")!), me: me, masterKey: Data(repeating: 1, count: 32))
    let dir = try #require(v.cacheDir)
    let list = dir.appendingPathComponent("list.json")
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(finishes(v.keepList(now: true)), "list.json write hung")
    #expect(FileManager.default.fileExists(atPath: list.path))
    // with the vault closed meanwhile: nothing is written, nothing hangs
    try? FileManager.default.removeItem(at: dir)
    v.close()
    #expect(finishes(v.keepList(now: true)))
    #expect(!FileManager.default.fileExists(atPath: list.path))
  }
}

// "Stay unlocked while an import or export runs": a screen lock waits for the work only with the option on.
@Suite struct StayUnlockedTests {
  @Test func aScreenLockWaitsOnlyForRunningWorkWithTheOptionOn() {
    #expect(StayUnlocked.onScreenLock(lockOnSleep: true, stay: false, working: true) == .lock)
    #expect(StayUnlocked.onScreenLock(lockOnSleep: true, stay: true, working: false) == .lock)
    #expect(StayUnlocked.onScreenLock(lockOnSleep: true, stay: true, working: true) == .later)
    #expect(StayUnlocked.onScreenLock(lockOnSleep: false, stay: true, working: true) == .nothing)
    #expect(StayUnlocked.onScreenLock(lockOnSleep: false, stay: false, working: false) == .nothing)
  }

  @MainActor @Test func keepingAwakeStartsAndEnds() {
    let k = KeepAwake()
    k.set(true); k.set(true)
    #expect(k.active)
    k.set(false)
    #expect(!k.active)
  }
}
