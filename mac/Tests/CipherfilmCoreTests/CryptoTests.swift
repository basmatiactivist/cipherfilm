// The Mac's crypto must read exactly what the web client wrote: these tests decrypt the committed vectors
// (tools/decrypt/testdata/vectors.json, made by web/src/crypto/vectors.gen.test.ts) and round-trip fresh data.
import Foundation
import Testing
@testable import CipherfilmCore

private struct Vectors: Decodable {
  struct File: Decodable { let id: String; let size: Int64; let count: Int; let wrapped_item_key: String; let meta_enc: String; let segment0: String; let sha256: String; let name: String }
  struct Sealed: Decodable { let id: String; let size: Int64; let name: String; let wrapped_item_key: String; let meta_enc: String }
  struct Album: Decodable { let id: String; let name: String; let name_enc: String }
  let email: String; let password: String; let kdf: KdfParams; let wrapped_master_pw: String; let wrapped_privkey: String; let pubkey: String
  let sealed: Sealed; let album: Album; let files: [File]
}

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private func vectors() throws -> Vectors {
  try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: repo.appendingPathComponent("tools/decrypt/testdata/vectors.json")))
}

private struct Meta: Decodable { let name: String; let size: Int64 }

@Suite struct CryptoTests {
  @Test func webVectors() throws {
    let v = try vectors()
    let (_, kek) = try Crypto.deriveFromPassword(v.password, v.kdf)
    let master = try Crypto.unlockMasterKey(email: v.email, kek: kek, wrappedMasterPw: v.wrapped_master_pw)
    #expect(try Crypto.decryptAlbumName(B64.decode(v.album.name_enc), master: master, albumId: v.album.id) == v.album.name)
    for f in v.files {
      let key = try Crypto.unwrapAnyItemKey(B64.decode(f.wrapped_item_key), master: master, pair: { fatalError() }, itemId: f.id)
      let meta = try JSONDecoder().decode(Meta.self, from: Crypto.decryptMeta(B64.decode(f.meta_enc), itemKey: key, itemId: f.id))
      #expect(meta.name == f.name && meta.size == f.size)
      let plain = try Segments.decrypt(itemKey: key, itemId: f.id, index: 0, count: f.count, total: f.size, blob: B64.decode(f.segment0))
      #expect(Hex.encode(Sodium.sha256(plain)) == f.sha256)
      // another item id, another size or a flipped bit must fail
      #expect(throws: CryptoError.self) { try Segments.decrypt(itemKey: key, itemId: v.files[0].id == f.id ? v.files[1].id : v.files[0].id, index: 0, count: f.count, total: f.size, blob: B64.decode(f.segment0)) }
      var bad = try B64.decode(f.segment0)
      bad[bad.count - 3] ^= 1
      #expect(throws: CryptoError.self) { try Segments.decrypt(itemKey: key, itemId: f.id, index: 0, count: f.count, total: f.size, blob: bad) }
    }
    // the background backup's sealed item key opens with the private key, and the public key is the computed one
    let pair = try Crypto.accountKeyPair(wrappedPrivkey: B64.decode(v.wrapped_privkey), masterKey: master, email: v.email)
    #expect(B64.encode(pair.pk) == v.pubkey)
    let sk = try Crypto.unwrapAnyItemKey(B64.decode(v.sealed.wrapped_item_key), master: master, pair: { pair }, itemId: v.sealed.id)
    let sm = try JSONDecoder().decode(Meta.self, from: Crypto.decryptMeta(B64.decode(v.sealed.meta_enc), itemKey: sk, itemId: v.sealed.id))
    #expect(sm.name == v.sealed.name && sm.size == v.sealed.size)
    #expect(throws: CryptoError.self) { try Crypto.unwrapAnyItemKey(B64.decode(v.sealed.wrapped_item_key), master: master, pair: { pair }, itemId: v.files[0].id) }
  }

  @Test func segmentsRoundTrip() throws {
    let id = "0123456789abcdef0123456789abcdef"
    let key = Crypto.newItemKey()
    for total in [0, 1, 65535, 65536, 65537, 200_000, Segments.plain + 70_000] {
      let data = Sodium.random(total)
      let n = Segments.count(Int64(total))
      var back = Data()
      for i in 0..<n {
        let len = total == 0 ? 0 : Segments.plainLen(Int64(total), i)
        let part = data.subdata(in: (i * Segments.plain)..<(i * Segments.plain + len))
        let ct = try Segments.encrypt(itemKey: key, itemId: id, index: i, count: n, total: Int64(total), plain: part)
        #expect(ct.count == Segments.cipherLen(len))
        back.append(try Segments.decrypt(itemKey: key, itemId: id, index: i, count: n, total: Int64(total), blob: ct))
      }
      #expect(back == data)
    }
  }

  /** Sizes and counts no honest upload has are refused, not computed with (an overflow would stop the app). */
  @Test func segmentsOutOfRange() {
    let id = "0123456789abcdef0123456789abcdef", key = Crypto.newItemKey()
    for (total, count) in [(Int64.max, 1), (-1, 1), (Int64(1) << 55, 1 << 33), (Segments.maxTotal + 1, Segments.count(Segments.maxTotal))] {
      #expect(throws: CryptoError.self) {
        try Segments.decrypt(itemKey: key, itemId: id, index: 0, count: count, total: total, blob: Data(count: Segments.cipherLen(Segments.plain)))
      }
    }
  }

  @Test func sealedFormats() throws {
    let kp = Sodium.boxKeypair()
    let pair = KeyPair(pk: kp.pk, sk: kp.sk)
    let id = "5e23456789abcdef0123456789abcdef"
    let k = Crypto.newItemKey()
    let w = try Crypto.sealItemKey(k, pk: kp.pk, itemId: id)
    #expect(w.count == Crypto.sealedItemKeyLen && w[0] == 2)
    #expect(try Crypto.openSealedItemKey(w, pair: pair, itemId: id) == k)
    let json = Data(#"{"v":1,"m":"mcs2/2","clip":"AAAA"}"#.utf8)
    let e = try Crypto.sealIndexEntry(json, pk: kp.pk, itemId: id)
    #expect(e.count == 1 + 48 + 16 + 512)
    #expect(try Crypto.openIndexEntry(e, pair: pair, itemId: id) == json)
    #expect(throws: CryptoError.self) { try Crypto.openIndexEntry(e, pair: pair, itemId: "00000000000000000000000000000000") }
    let master = Sodium.random(32)
    let doc = Data(#"{"v":1,"people":[]}"#.utf8)
    let p = Crypto.encryptPeople(doc, master: master, userId: "u1")
    #expect(p.count == 1 + 24 + 1024 + 16)
    #expect(try Crypto.decryptPeople(p, master: master, userId: "u1") == doc)
    #expect(throws: CryptoError.self) { try Crypto.decryptPeople(p, master: master, userId: "u2") }
  }

  @Test func kdfIsLibsodiums() throws {
    // crypto_kdf_derive_from_key is keyed BLAKE2b with the id as salt and the context as personalisation: a fixed value
    let k = Sodium.subkey(Data(repeating: 7, count: 32), "ITEMMETA", 0)
    #expect(k.count == 32)
    #expect(k != Sodium.subkey(Data(repeating: 7, count: 32), "ITEMMETA", 1))
    #expect(Crypto.fingerprint(name: "a.jpg", size: 1).count == 32)
    #expect(try B64.decode(B64.encode(Data([0xfb, 0xff, 0x01]))) == Data([0xfb, 0xff, 0x01]))
  }
}
