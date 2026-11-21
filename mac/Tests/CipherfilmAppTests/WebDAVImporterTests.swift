// The WebDAV import holds the library's names and sizes while unlocked: a lock lets go of them and stops it, a
// sign-out forgets the account's folders too; without its password nothing is read.
import Foundation
import Testing
@testable import Cipherfilm
@testable import CipherfilmCore

@MainActor @Suite struct WebDAVImporterTests {
  let user = "0123456789abcdef0123456789abcdee"

  @Test func stopsAtLockAndForgetsAtSignOut() async throws {
    let w = WebDAVImporter()
    var s = AccountSettings()
    s.pubkey = B64.encode(Data(repeating: 9, count: 32))
    s.webdav = [WebDAVSource(id: "11111111-2222-3333-4444-555555555555", url: "https://dav.example.org/p/", user: "u")]
    w.configure(api: API(base: URL(string: "https://127.0.0.1:9")!), userId: user, settings: s, unlocked: true)
    let it = Item(id: "0123456789abcdef0123456789abcdef", kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true,
                  favorite: false, trashedAt: nil, purgeAt: nil, meta: ItemMeta(name: "a.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0),
                  itemKey: nil, broken: false)
    w.libraryChanged([it])
    #expect(w.knownPrints == [Crypto.fingerprint(name: "a.jpg", size: 1)])
    // no password in the keychain: the folder says so, nothing runs (the keychain is read off the main thread)
    for _ in 0..<200 where w.running { try await Task.sleep(for: .milliseconds(10)) }
    #expect(!w.running)
    #expect(w.status[s.webdav[0].id]?.phase == .problem)
    w.stop() // lock
    #expect(w.knownPrints.isEmpty && !w.running)
    w.libraryChanged([it]) // a late library load after the lock doesn't start it
    #expect(!w.running)
    w.stop(forget: true) // sign-out
    #expect(w.status.isEmpty)
  }

  @Test func idsStayInsideTheAccountFolder() {
    #expect(WebDAVImporter.safe("11111111-2222-3333-4444-555555555555") == "11111111-2222-3333-4444-555555555555")
    #expect(WebDAVImporter.safe("../../x") == "invalid")
  }
}
