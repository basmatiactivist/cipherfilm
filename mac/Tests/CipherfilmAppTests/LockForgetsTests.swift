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
}
