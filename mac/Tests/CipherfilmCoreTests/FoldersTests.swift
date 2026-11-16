// The archive and the locked folder (Folders.swift): the same cases as web/src/edit/folders.test.ts, and the change
// as it is written: every field kept, the version raised, the flag only inside the encrypted metadata.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct FoldersTests {
  private func meta(_ json: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
  }

  private func item(_ id: String, _ extra: String?, broken: Bool = false) throws -> Item {
    let m = try extra.map { e in
      try JSONDecoder().decode(ItemMeta.self, from: Data(#"{"name":"a.jpg","mime":"image/jpeg","size":1,"lastModified":0,"capture_ts":0\#(e)}"#.utf8))
    }
    return Item(id: id, kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true, favorite: false,
                trashedAt: nil, purgeAt: nil, meta: m, itemKey: nil, broken: broken)
  }

  @Test func readsOnlyTrueAsSet() throws {
    #expect(Folders.folderOf(try meta("{}")) == .library)
    #expect(Folders.folderOf(try meta(#"{"archived":true}"#)) == .archive)
    #expect(Folders.folderOf(try meta(#"{"locked":true}"#)) == .locked)
    #expect(Folders.folderOf(try meta(#"{"locked":true,"archived":true}"#)) == .locked)
    #expect(!Folders.isArchived(try meta(#"{"locked":true,"archived":true}"#)))
    for v in [#""true""#, "1", #""yes""#, "{}", "null"] {
      #expect(!Folders.isLocked(try meta(#"{"locked":\#(v)}"#)))
      #expect(!Folders.isArchived(try meta(#"{"archived":\#(v)}"#)))
    }
    #expect(!Folders.isLocked(nil))
    // dictionaries built in Swift too: a number is never a flag
    #expect(!Folders.isLocked(["locked": 1]))
    #expect(Folders.isLocked(["locked": true]))
  }

  @Test func theDecryptedItemReadsOnlyTrueToo() throws {
    #expect(try item("1", #","locked":true"#).folder == .locked)
    #expect(try item("2", #","archived":true"#).folder == .archive)
    #expect(try item("3", #","locked":true,"archived":true"#).folder == .locked)
    for v in [#""true""#, "1", #""yes""#, "{}", "null", "[true]"] {
      // any other value is "not set", and the item still decrypts
      let it = try item("4", #","locked":\#(v),"archived":\#(v)"#)
      #expect(it.folder == .library && it.name == "a.jpg")
    }
  }

  @Test func normFoldersDropsValuesThatArentTrue() throws {
    let a = Folders.normFolders(try meta(#"{"name":"a","locked":"true","archived":1}"#))
    #expect(a.keys.sorted() == ["name"])
    let b = Folders.normFolders(try meta(#"{"name":"a","locked":true}"#))
    #expect(b.keys.sorted() == ["locked", "name"] && Folders.isLocked(b))
  }

  @Test func withFolderSetsOneFlagAndKeepsEveryOtherField() throws {
    let m = try meta(#"{"name":"a.jpg","gps":{"lat":1,"lon":2},"mv":3,"future":{"x":1},"archived":true}"#)
    let locked = Folders.withFolder(m, .locked)
    #expect(locked.keys.sorted() == ["future", "gps", "locked", "mv", "name"])
    #expect(Folders.isLocked(locked) && (locked["future"] as? [String: Any])?["x"] as? Int == 1 && (locked["gps"] as? [String: Any])?["lat"] as? Int == 1)
    #expect(Folders.withFolder(m, .library).keys.sorted() == ["future", "gps", "mv", "name"])
    #expect(Folders.withFolder(["locked": true], .archive).keys.sorted() == ["archived"])
    #expect(Folders.isTrue(m["archived"])) // the input is unchanged
  }

  @Test func aLockedItemNeverReachesTheOpenList() throws {
    let list = [try item("1", ""), try item("2", #","locked":true"#), try item("3", #","archived":true"#), try item("4", nil, broken: true),
                try item("5", #","locked":true,"archived":true"#)]
    let (open, locked) = Folders.splitLocked(list)
    #expect(open.map(\.id) == ["1", "3", "4"])
    #expect(locked.map(\.id) == ["2", "5"])
    #expect(Folders.mainGrid(list).map(\.id) == ["1", "4"])
    #expect(Folders.archived(list).map(\.id) == ["3"])
  }

  @Test func theVersionRises() throws {
    #expect(Folders.metaVersion(try meta("{}")) == 0)
    #expect(Folders.metaVersion(try meta(#"{"mv":7}"#)) == 7)
    for bad in ["-1", #""3""#, "1.5", "1e300", "true", "null"] { #expect(Folders.metaVersion(try meta(#"{"mv":\#(bad)}"#)) == 0) }
    #expect(Folders.nextVersion(try meta(#"{"mv":7}"#))["mv"] as? Int == 8)
    #expect(Folders.nextVersion(try meta("{}"))["mv"] as? Int == 1)
  }

  /** The write: decrypted as a plain dictionary, moved, the version raised, sealed again; unknown fields survive, and
   *  the flag exists only inside the ciphertext. */
  @Test func theSealedChangeKeepsUnknownFieldsAndHidesTheFlag() throws {
    let key = Data(repeating: 9, count: 32)
    let id = "0123456789abcdef0123456789abcdef"
    let original = #"{"name":"a.jpg","mime":"image/jpeg","size":3,"lastModified":1,"capture_ts":1700000000000,"gps":{"lat":47.37689,"lon":8.541694},"sha256":"ab","mv":4,"edit":{"rot":90,"v":2},"future":{"nested":[1,"two",null]},"archived":true}"#
    let sealed0 = Crypto.encryptMeta(Data(original.utf8), itemKey: key, itemId: id)
    let sealed = try Folders.resealed(sealed0, itemKey: key, itemId: id, to: .locked)
    // no plaintext of the change (nor of anything else) in what the server gets
    for word in ["locked", "archived", "true", "a.jpg", "future", "\"mv\""] { #expect(sealed.range(of: Data(word.utf8)) == nil) }
    #expect(sealed.count == sealed0.count) // padded to the same 256-byte block as before
    let back = try JSONSerialization.jsonObject(with: Crypto.decryptMeta(sealed, itemKey: key, itemId: id)) as! [String: Any]
    #expect(Folders.folderOf(back) == .locked && back["archived"] == nil)
    #expect(Folders.metaVersion(back) == 5)
    #expect((back["future"] as? [String: Any])?["nested"] as? NSArray == [1, "two", NSNull()] as NSArray)
    #expect((back["gps"] as? [String: Any])?["lat"] as? Double == 47.37689)
    #expect(back["capture_ts"] as? Double == 1_700_000_000_000)
    #expect(back["sha256"] as? String == "ab" && (back["edit"] as? [String: Any])?["v"] as? Int == 2)
    // the app reads it back as locked
    let m = try JSONDecoder().decode(ItemMeta.self, from: Crypto.decryptMeta(sealed, itemKey: key, itemId: id))
    #expect(m.locked?.value == true && m.archived == nil)
    // and out again: no flag, version 6
    let out = try Folders.resealed(sealed, itemKey: key, itemId: id, to: .library)
    let o = try JSONSerialization.jsonObject(with: Crypto.decryptMeta(out, itemKey: key, itemId: id)) as! [String: Any]
    #expect(Folders.folderOf(o) == .library && o["locked"] == nil && Folders.metaVersion(o) == 6 && o["future"] != nil)
    // another item's key or id doesn't open it
    #expect(throws: (any Error).self) { try Crypto.decryptMeta(sealed, itemKey: key, itemId: "f123456789abcdef0123456789abcdef") }
  }
}
