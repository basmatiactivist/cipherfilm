// The keychain item for the Touch ID key: written, read back, replaced and deleted by the app that wrote it.
// (That another program gets macOS's prompt instead of the data is the keychain's own access list; it can't be
// clicked through in a test.)
import Foundation
import Testing
@testable import CipherfilmCore

@Suite(.serialized) struct KeychainTests {
  let service = "app.cipherfilm.mac.tests.\(UUID().uuidString)"

  @Test func writeReadReplaceDelete() throws {
    defer { Keychain.delete(service: service, account: "u1") }
    #expect(Keychain.get(service: service, account: "u1") == nil)
    #expect(!Keychain.exists(service: service, account: "u1"))
    try Keychain.set(Data("one".utf8), service: service, account: "u1", label: "Cipherfilm test")
    #expect(Keychain.exists(service: service, account: "u1"))
    #expect(Keychain.get(service: service, account: "u1") == Data("one".utf8))
    try Keychain.set(Data("two".utf8), service: service, account: "u1", label: "Cipherfilm test")
    #expect(Keychain.get(service: service, account: "u1") == Data("two".utf8))
    #expect(Keychain.get(service: service, account: "u2") == nil)
    Keychain.delete(service: service, account: "u1")
    #expect(Keychain.get(service: service, account: "u1") == nil)
  }
}
