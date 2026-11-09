// A small secret in the login keychain that only this app can read: the item's access list trusts exactly the app
// that wrote it (its code signature), so another program of the same user gets macOS's own prompt for the Mac's
// password instead of the data. With the app's ad-hoc signature each new version is a new signature, so after an
// update macOS asks once ("Always Allow" then trusts the new version). Used for the Touch ID key's handle (TouchID.swift).
import Foundation
import Security

public enum Keychain {
  public enum Failure: Error, Equatable { case status(OSStatus) }

  private static func base(service: String, account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  /** Writes (or replaces) the item; only this app is on its access list. */
  public static func set(_ data: Data, service: String, account: String, label: String) throws {
    delete(service: service, account: account)
    var q = base(service: service, account: account)
    q[kSecValueData as String] = data
    q[kSecAttrLabel as String] = label
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
    var me: SecTrustedApplication?
    var access: SecAccess?
    // nil path: the calling application itself
    if SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let me,
       SecAccessCreate(label as CFString, [me] as CFArray, &access) == errSecSuccess, let access {
      q[kSecAttrAccess as String] = access
    }
    let st = SecItemAdd(q as CFDictionary, nil)
    guard st == errSecSuccess else { throw Failure.status(st) }
  }

  /** The item's data; nil if there is none (or the person refused macOS's prompt). */
  public static func get(service: String, account: String) -> Data? {
    var q = base(service: service, account: account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
    return out as? Data
  }

  /** Whether the item exists, without reading its data (so without a prompt). */
  public static func exists(service: String, account: String) -> Bool {
    var q = base(service: service, account: account)
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
  }

  public static func delete(service: String, account: String) {
    SecItemDelete(base(service: service, account: account) as CFDictionary)
  }
}
