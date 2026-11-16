// The metadata versions seen (MetaVersion.swift): the same cases as web/src/crypto/metaVersion.test.ts, and the Mac's
// list against a server that hands out an older sealed copy, with the real crypto.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct MetaVersionTests {
  private let A = String(repeating: "a", count: 32), B = String(repeating: "b", count: 32)

  @Test func refusesAnOlderVersionAcceptsTheSameOrNewer() {
    let h = MetaHighWater(file: nil)
    #expect(h.check(A, 2, nil))
    #expect(!h.check(A, 1, nil)) // a replayed older copy
    #expect(!h.check(A, 0, nil))
    #expect(h.check(A, 2, nil))
    #expect(h.check(A, 3, nil))
    #expect(h.highest(A) == 3)
    #expect(h.check(B, 0, nil)) // never changed: nothing kept
    #expect(h.highest(B) == 0)
  }

  @Test func neverForgetsAnItemToMakeRoom() {
    // a server could list thousands of items it made itself (sealed to the account's public key) to push a real item
    // out, then hand out that item's older metadata
    let h = MetaHighWater(file: nil, max: 3)
    #expect(h.check(A, 2, nil))
    for i in 0..<10 { _ = h.check(String(format: "%032x", i), 1, nil) }
    #expect(!h.check(A, 1, nil))
    #expect(h.highest(A) == 2)
    #expect(!h.check(String(repeating: "f", count: 32), 1, nil)) // can't be noted: handled as stale
    #expect(h.check(String(repeating: "e", count: 32), 0, nil))
    #expect(h.check(A, 3, nil))
  }

  @Test func refusesAnotherCopyAtTheVersionSeen() {
    let d1 = String(repeating: "1", count: 64), d2 = String(repeating: "2", count: 64)
    let h = MetaHighWater(file: nil)
    #expect(h.check(A, 1, d1))
    #expect(h.check(A, 1, d1))
    #expect(!h.check(A, 1, d2))
    #expect(h.check(A, 2, d2))
    h.wrote(B, 1, d2)
    #expect(!h.check(B, 1, d1))
    #expect(MetaHighWater.digest("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }

  @Test func isKeptInAFileOnlyUnderAnAccountId() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-mv-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(MetaHighWater.file(for: "../autolock", in: dir) == nil)
    let f = try #require(MetaHighWater.file(for: A, in: dir))
    let h = MetaHighWater(file: f)
    _ = h.check(A, 2, String(repeating: "3", count: 64)); _ = h.check(B, 0, nil)
    h.flush()
    let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [[Any]]
    #expect(saved?.count == 1 && saved?[0][0] as? String == A && saved?[0][1] as? Int == 2 && saved?[0][2] as? String == String(repeating: "3", count: 16))
    let again = MetaHighWater(file: f)
    #expect(again.highest(A) == 2)
    #expect(!again.check(A, 2, String(repeating: "4", count: 64)))
    // the format of the other apps' files from before digests, and junk
    try Data(#"[["\#(A)",3],["x",5],["\#(B)",-1],["\#(B)",true],null]"#.utf8).write(to: f)
    let old = MetaHighWater(file: f)
    #expect(old.highest(A) == 3 && old.highest(B) == 0)
    MetaHighWater.forgetAll(in: dir)
    #expect(!FileManager.default.fileExists(atPath: dir.path))
  }

  @Test func theVersionIsReadLikeTheOtherApps() throws {
    func v(_ s: String) throws -> Int { try JSONDecoder().decode(ItemMeta.self, from: Data(#"{"name":"a","mime":"","size":1,"capture_ts":0\#(s)}"#.utf8)).version }
    #expect(try v("") == 0)
    #expect(try v(#","mv":3"#) == 3)
    for bad in [#""4""#, "1.5", "-1", "true", "null", "9007199254740993"] { #expect(try v(#","mv":\#(bad)"#) == 0) }
  }

  // ---- the list ----

  private let master = Data(repeating: 5, count: 32)
  private let id = "0123456789abcdef0123456789abcdef"

  private func vault(_ versions: MetaHighWater) throws -> Vault {
    let json = """
    {"user":{"id":"\(String(repeating: "9", count: 32))","email":"a@x.org","role":"user"},"csrf":"c","kdf":{"alg":"argon2id13","v":1,"ops":3,"mem":67108864,"salt":"AAAAAAAAAAAAAAAAAAAAAA"},
     "wrapped_master_pw":"x","wrapped_privkey":"x","pubkey":"x"}
    """
    let me = try JSONDecoder().decode(Me.self, from: Data(json.utf8))
    return Vault(api: API(base: URL(string: "https://127.0.0.1:9")!), me: me, masterKey: master, versions: versions)
  }

  private func record(_ key: Data, _ meta: String) -> RawItem {
    let json = Data(#"{"name":"a.jpg","mime":"image/jpeg","size":10,"lastModified":1,"capture_ts":1\#(meta)}"#.utf8)
    return RawItem(id: id, kind: "image", size: 10, segment_count: 1, wrapped_item_key: B64.encode(Crypto.wrapItemKey(key, master: master, itemId: id)),
                   meta_enc: B64.encode(Crypto.encryptMeta(json, itemKey: key, itemId: id)), has_thumb: true, has_preview: true, created_at: 1,
                   favorite: nil, trashed_at: nil, purge_at: nil)
  }

  @Test func anOlderCopyFromTheServerIsStaleAndHandledAsLocked() throws {
    let key = Crypto.newItemKey()
    let versions = MetaHighWater(file: nil)
    var v = try vault(versions)
    let locked = record(key, #","locked":true,"mv":1"#)
    let first = try v.decrypt([locked])[0]
    #expect(first.isLocked && !first.stale && first.base == MetaHighWater.digest(locked.meta_enc))
    // in the session: the newer copy stays
    let replay = record(key, #","gps":{"lat":46.5,"lon":7.5}"#)
    let kept = try v.decrypt([replay])[0]
    #expect(kept.isLocked && !kept.stale && kept.meta?.gps == nil && kept.base == first.base)
    // after a lock (or a restart): only the version is known, the item is stale and stays out of every open view
    v.close()
    v = try vault(versions)
    let stale = try v.decrypt([replay])[0]
    #expect(stale.stale && stale.isLocked)
    #expect(Folders.splitLocked([stale]).open.isEmpty)
    // another copy at the version seen (made from the copy before the lock) too
    #expect(try v.decrypt([record(key, #","archived":true,"mv":1"#)])[0].stale)
    // a newer version is taken as usual
    #expect(try !v.decrypt([record(key, #","mv":2"#)])[0].stale)
  }

  @Test func aMoveIsWrittenAboveTheHighestVersionSeen() throws {
    let key = Crypto.newItemKey()
    let sealed = Crypto.encryptMeta(Data(#"{"name":"a","mv":1,"future":7}"#.utf8), itemKey: key, itemId: id)
    let (out, version) = try Folders.resealedVersion(sealed, itemKey: key, itemId: id, to: .archive, above: 4)
    #expect(version == 5)
    let m = try JSONSerialization.jsonObject(with: Crypto.decryptMeta(out, itemKey: key, itemId: id)) as? [String: Any]
    #expect(m?["mv"] as? Int == 5 && m?["future"] as? Int == 7 && Folders.isTrue(m?["archived"]))
  }

  @Test func aStaleItemIsNeverMoved() async throws {
    let v = try vault(MetaHighWater(file: nil))
    var it = try v.decrypt([record(Crypto.newItemKey(), "")])[0]
    it.stale = true
    await #expect(throws: (any Error).self) { try await v.move([it], to: .library) }
  }
}
