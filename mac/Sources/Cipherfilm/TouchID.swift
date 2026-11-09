// Unlock with Touch ID. A key in the Mac's Secure Enclave (P-256, usable only after a Touch ID check with the
// fingerprints enrolled now) locks a copy of the master key: ECDH between that key and a one-time key, HKDF-SHA256,
// ChaCha20-Poly1305 bound to the account. The Secure Enclave key never leaves the chip; its wrapped handle and the
// locked copy are kept in the login keychain, readable only by this app (Keychain.swift), so another program of the
// same user can't take the handle and ask for a fingerprint in the app's name. A new fingerprint makes it useless (the
// app then asks for the password and turns Touch ID off), and sign-out deletes it.
import CryptoKit
import Foundation
import LocalAuthentication
import CipherfilmCore

enum TouchID {
  struct Stored: Codable {
    var v = 1
    var handle: Data // the Secure Enclave key's dataRepresentation (opaque, only this Mac's chip can use it)
    var ephemeral: Data // the one-time public key, x9.63
    var sealed: Data // ChaChaPoly combined: nonce || ciphertext || tag
  }

  /** Where versions before 2.5.2 kept it: moved into the keychain on first use, then deleted. */
  static func file(_ userId: String) -> AccountFile<Stored> { AccountFile(userId: userId, name: "touchid.json") }

  // the dev build (its own bundle id) keeps its own item
  private static var service: String { "\(Bundle.main.bundleIdentifier ?? "app.cipherfilm.mac").touchid" }

  private static func save(_ st: Stored, _ userId: String) throws {
    try Keychain.set(try JSONEncoder().encode(st), service: service, account: userId, label: "Cipherfilm Touch ID")
  }

  /** The stored key: from the keychain, or from an older version's file (then moved into the keychain). */
  private static func stored(_ userId: String) -> Stored? {
    if let d = Keychain.get(service: service, account: userId) { return try? JSONDecoder().decode(Stored.self, from: d) }
    guard let old = file(userId).read() else { return nil }
    if (try? save(old, userId)) != nil { try? FileManager.default.removeItem(at: file(userId).url) }
    return old
  }

  static var available: Bool {
    var e: NSError?
    return SecureEnclave.isAvailable && LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
  }

  static func enabled(_ userId: String) -> Bool { Keychain.exists(service: service, account: userId) || file(userId).read() != nil }

  private static func key(_ secret: SharedSecret, _ userId: String) -> SymmetricKey {
    secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("cipherfilm-mac-touchid-v1".utf8), sharedInfo: Data(userId.utf8), outputByteCount: 32)
  }

  /** Turns it on: asks for Touch ID once (so a person can't turn it on without a finger that works). */
  static func enable(master: Data, userId: String) async throws {
    let ctx = LAContext()
    ctx.localizedReason = "turn on Touch ID for Cipherfilm"
    try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "turn on unlocking with Touch ID")
    var err: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &err) else {
      throw APIError(status: -1, message: "Touch ID isn't available on this Mac.")
    }
    let se = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access, authenticationContext: ctx)
    let eph = P256.KeyAgreement.PrivateKey()
    let secret = try eph.sharedSecretFromKeyAgreement(with: se.publicKey)
    let box = try ChaChaPoly.seal(master, using: key(secret, userId), authenticating: Data("cipherfilm/master/\(userId)".utf8))
    try save(Stored(handle: se.dataRepresentation, ephemeral: eph.publicKey.x963Representation, sealed: box.combined), userId)
  }

  static func disable(_ userId: String) {
    Keychain.delete(service: service, account: userId)
    try? FileManager.default.removeItem(at: file(userId).url)
  }

  /** The master key after a Touch ID check; nil when the person cancelled. Throws when the stored key no longer works. */
  static func unlock(me: Me) async throws -> Data? {
    let userId = me.user.id
    guard let st = stored(userId) else { return nil }
    let ctx = LAContext()
    do {
      try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "unlock your library")
    } catch let e as LAError where [.userCancel, .appCancel, .systemCancel, .userFallback].contains(e.code) {
      return nil
    }
    do {
      let se = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: st.handle, authenticationContext: ctx)
      let secret = try se.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: st.ephemeral))
      let master = try ChaChaPoly.open(ChaChaPoly.SealedBox(combined: st.sealed), using: key(secret, userId), authenticating: Data("cipherfilm/master/\(userId)".utf8))
      guard Account.keyFits(me: me, key: master) else { throw CryptoError.failed("wrong key") }
      return master
    } catch {
      disable(userId) // fingerprints changed, or the key doesn't fit the account any more
      throw APIError(status: -1, message: "Fingerprints changed, so Touch ID was turned off. Unlock with your password and turn it on again in Settings.")
    }
  }
}
