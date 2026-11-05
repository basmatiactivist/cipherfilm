// The formats of docs/CRYPTO.md, byte for byte as web/src/crypto/* writes them. The test target decrypts the vectors
// the web client made (tools/decrypt/testdata/vectors.json) and checks the details that are easy to get wrong.
import Foundation

public enum CTX {
  public static let auth = "AUTHKEY1", kek = "KEKWRAP1", recAuth = "RECAUTH1", recWrap = "RECWRAP1"
  public static let albumName = "ALBUMNAM", itemMeta = "ITEMMETA", itemThumb = "ITEMTHMB", itemPrev = "ITEMPREV", itemSeg = "ITEMSEGM"
  public static let people = "PEOPLEST"
}

public enum Label {
  public static let masterPw = "wrap/master/pw", masterRecovery = "wrap/master/recovery", privkey = "wrap/privkey"
  public static let itemKey = "wrap/item", meta = "meta"
}

public struct KdfParams: Codable, Sendable, Equatable {
  public var alg: String
  public var v: Int
  public var ops: Int
  public var mem: Int
  public var salt: String
  public init(alg: String, v: Int, ops: Int, mem: Int, salt: String) { self.alg = alg; self.v = v; self.ops = ops; self.mem = mem; self.salt = salt }
}

public struct KeyPair: Sendable {
  public let pk: Data
  public let sk: Data
}

public enum Crypto {
  /** The owner binding for account keys: the normalised e-mail. */
  public static func normEmail(_ e: String) -> String { e.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

  // ---- §3 wrapping: 0x01 || nonce(24) || AEAD(plaintext, ad = label \0 owner) ----

  static func ad(_ label: String, _ owner: String) -> Data { Data((label + "\u{0}" + owner).utf8) }

  public static func seal(_ plaintext: Data, key: Data, label: String, owner: String) -> Data {
    let nonce = Sodium.random(Sodium.aeadNonce)
    var out = Data([1])
    out.append(nonce)
    out.append(Sodium.aeadEncrypt(plaintext, ad: ad(label, owner), nonce: nonce, key: key))
    return out
  }

  public static func open(_ blob: Data, key: Data, label: String, owner: String) throws -> Data {
    let b = Data(blob)
    guard b.count >= 1 + Sodium.aeadNonce + Sodium.aeadTag, b[0] == 1 else { throw CryptoError.failed("bad blob") }
    return try Sodium.aeadDecrypt(b.subdata(in: (1 + Sodium.aeadNonce)..<b.count), ad: ad(label, owner), nonce: b.subdata(in: 1..<(1 + Sodium.aeadNonce)), key: key)
  }

  // ---- §1/§2 account ----

  /** The same bounds as the server and the other clients: a server can't talk the app into weak or absurd settings. */
  public static func assertSaneKdf(_ k: KdfParams) throws {
    guard k.alg == "argon2id13", k.v == 1, (2...10).contains(k.ops), (32 << 20...1 << 30).contains(k.mem) else {
      throw CryptoError.failed("The server sent unexpected password-hashing settings. Sign-in was stopped for your safety.")
    }
  }

  /** password -> Argon2id -> (authKey, KEK). The password is NFKC-normalised like String.normalize("NFKC"). */
  public static func deriveFromPassword(_ password: String, _ p: KdfParams) throws -> (authKey: Data, kek: Data) {
    guard p.alg == "argon2id13", p.v == 1 else { throw CryptoError.failed("unsupported kdf params") }
    var root = try Sodium.argon2id(password.precomposedStringWithCompatibilityMapping, salt: B64.decode(p.salt), ops: p.ops, mem: p.mem)
    defer { Sodium.memzero(&root) }
    return (Sodium.subkey(root, CTX.auth, 1), Sodium.subkey(root, CTX.kek, 2))
  }

  public static func unlockMasterKey(email: String, kek: Data, wrappedMasterPw: String) throws -> Data {
    try open(B64.decode(wrappedMasterPw), key: kek, label: Label.masterPw, owner: normEmail(email))
  }

  /** The account's key pair, opened with the master key; the public half is computed, not taken from the server. */
  public static func accountKeyPair(wrappedPrivkey: Data, masterKey: Data, email: String) throws -> KeyPair {
    let sk = try open(wrappedPrivkey, key: masterKey, label: Label.privkey, owner: normEmail(email))
    return KeyPair(pk: Sodium.scalarmultBase(sk), sk: sk)
  }

  // ---- item keys ----

  public static func newItemKey() -> Data { Sodium.random(32) }

  public static func wrapItemKey(_ itemKey: Data, master: Data, itemId: String) -> Data { seal(itemKey, key: master, label: Label.itemKey, owner: itemId) }

  public static let sealedItemKeyLen = 1 + 48 + 48

  /** version(2) || crypto_box_seal(itemKey || item id as 16 bytes, pk): for uploads without the master key. */
  public static func sealItemKey(_ itemKey: Data, pk: Data, itemId: String) throws -> Data {
    var pt = itemKey
    pt.append(try Hex.decode(itemId))
    defer { Sodium.memzero(&pt) }
    var out = Data([2])
    out.append(try Sodium.boxSeal(pt, pk: pk))
    return out
  }

  public static func openSealedItemKey(_ blob: Data, pair: KeyPair, itemId: String) throws -> Data {
    let b = Data(blob)
    guard b.count == sealedItemKeyLen, b[0] == 2 else { throw CryptoError.failed("bad blob") }
    var pt = try Sodium.boxSealOpen(b.subdata(in: 1..<b.count), pk: pair.pk, sk: pair.sk)
    defer { Sodium.memzero(&pt) }
    let id = try Hex.decode(itemId)
    guard pt.count == 48, id.count == 16, Sodium.equal(pt.subdata(in: 32..<48), id) else { throw CryptoError.failed("item key belongs to another item") }
    return pt.subdata(in: 0..<32)
  }

  /** Either kind of item key; pair() is asked only when a sealed one turns up. */
  public static func unwrapAnyItemKey(_ wrapped: Data, master: Data, pair: () throws -> KeyPair, itemId: String) throws -> Data {
    let w = Data(wrapped)
    if w.first == 2 { return try openSealedItemKey(w, pair: pair(), itemId: itemId) }
    return try open(w, key: master, label: Label.itemKey, owner: itemId)
  }

  // ---- metadata, thumbnails, previews, album names ----

  public static func encryptMeta(_ json: Data, itemKey: Data, itemId: String) -> Data {
    seal(Sodium.pad(json, 256), key: Sodium.subkey(itemKey, CTX.itemMeta, 0), label: Label.meta, owner: itemId)
  }

  public static func decryptMeta(_ blob: Data, itemKey: Data, itemId: String) throws -> Data {
    try Sodium.unpad(open(blob, key: Sodium.subkey(itemKey, CTX.itemMeta, 0), label: Label.meta, owner: itemId), 256)
  }

  public static func encryptThumb(_ d: Data, itemKey: Data, itemId: String) -> Data { seal(d, key: Sodium.subkey(itemKey, CTX.itemThumb, 0), label: "thumb", owner: itemId) }
  public static func decryptThumb(_ d: Data, itemKey: Data, itemId: String) throws -> Data { try open(d, key: Sodium.subkey(itemKey, CTX.itemThumb, 0), label: "thumb", owner: itemId) }
  public static func encryptPreview(_ d: Data, itemKey: Data, itemId: String) -> Data { seal(d, key: Sodium.subkey(itemKey, CTX.itemPrev, 0), label: "preview", owner: itemId) }
  public static func decryptPreview(_ d: Data, itemKey: Data, itemId: String) throws -> Data { try open(d, key: Sodium.subkey(itemKey, CTX.itemPrev, 0), label: "preview", owner: itemId) }

  public static func encryptAlbumName(_ name: String, master: Data, albumId: String) -> Data {
    seal(Sodium.pad(Data(name.utf8), 64), key: Sodium.subkey(master, CTX.albumName, 0), label: "album/name", owner: albumId)
  }

  public static func decryptAlbumName(_ blob: Data, master: Data, albumId: String) throws -> String {
    let d = try Sodium.unpad(open(blob, key: Sodium.subkey(master, CTX.albumName, 0), label: "album/name", owner: albumId), 64)
    guard let s = String(data: d, encoding: .utf8) else { throw CryptoError.failed("bad name") }
    return s
  }

  // ---- search index entries: version(2) || crypto_box_seal(item id (16) || pad512(JSON), pk) ----

  public static func sealIndexEntry(_ json: Data, pk: Data, itemId: String) throws -> Data {
    let id = try Hex.decode(itemId)
    guard id.count == 16 else { throw CryptoError.failed("bad item id") }
    var pt = id
    pt.append(Sodium.pad(json, 512))
    var out = Data([2])
    out.append(try Sodium.boxSeal(pt, pk: pk))
    return out
  }

  public static func openIndexEntry(_ blob: Data, pair: KeyPair, itemId: String) throws -> Data {
    let b = Data(blob)
    guard b.count >= 1 + 48 + 16, b[0] == 2 else { throw CryptoError.failed("bad blob") }
    let pt = try Sodium.boxSealOpen(b.subdata(in: 1..<b.count), pk: pair.pk, sk: pair.sk)
    let id = try Hex.decode(itemId)
    guard pt.count >= 16, id.count == 16, Sodium.equal(pt.subdata(in: 0..<16), id) else { throw CryptoError.failed("index entry belongs to another item") }
    return try Sodium.unpad(pt.subdata(in: 16..<pt.count), 512)
  }

  // ---- the people document: seal(pad(JSON, 1024), kdf(master, "PEOPLEST", 0), "blob/people", user id) ----

  public static func encryptPeople(_ json: Data, master: Data, userId: String) -> Data {
    seal(Sodium.pad(json, 1024), key: Sodium.subkey(master, CTX.people, 0), label: "blob/people", owner: userId)
  }

  public static func decryptPeople(_ blob: Data, master: Data, userId: String) throws -> Data {
    try Sodium.unpad(open(blob, key: Sodium.subkey(master, CTX.people, 0), label: "blob/people", owner: userId), 1024)
  }

  /** A file by name and size, as the backup, search and "Free up space" recognise it: hex(generichash16(name \0 size)). */
  public static func fingerprint(name: String, size: Int64) -> String {
    Hex.encode(Sodium.genericHash(Data("\(name)\u{0}\(size)".utf8), length: 16))
  }
}

// ---- §4 the file format: 4 MiB segments, each a secretstream of 64 KiB chunks ----

public enum Segments {
  public static let plain = 4 * 1024 * 1024
  public static let chunk = 64 * 1024

  public static func count(_ total: Int64) -> Int { max(1, Int((total + Int64(plain) - 1) / Int64(plain))) }

  public static func plainLen(_ total: Int64, _ i: Int) -> Int { Int(min(Int64(plain), total - Int64(i) * Int64(plain))) }

  /** Ciphertext length of a plaintext segment of p bytes (an empty segment still has one final chunk). */
  public static func cipherLen(_ p: Int) -> Int { Sodium.ssHeader + p + max(1, (p + chunk - 1) / chunk) * Sodium.ssA }

  /** "seg" \0 itemId || u32be(i) || u32be(count) || u64be(total) */
  static func ad(_ itemId: String, _ i: Int, _ count: Int, _ total: Int64) -> Data {
    var d = Data(("seg\u{0}" + itemId).utf8)
    withUnsafeBytes(of: UInt32(i).bigEndian) { d.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(count).bigEndian) { d.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt64(total).bigEndian) { d.append(contentsOf: $0) }
    return d
  }

  public static func encrypt(itemKey: Data, itemId: String, index i: Int, count: Int, total: Int64, plain: Data) throws -> Data {
    guard plain.count == plainLen(total, i) || (total == 0 && plain.isEmpty) else { throw CryptoError.failed("unexpected segment length") }
    var key = Sodium.subkey(itemKey, CTX.itemSeg, UInt64(i))
    defer { Sodium.memzero(&key) }
    let s = Sodium.PushStream(key: key)
    let a = ad(itemId, i, count, total)
    var out = Data(capacity: cipherLen(plain.count))
    out.append(s.header)
    let p = Data(plain)
    p.withUnsafeBytes { buf in
      var off = 0
      repeat {
        let end = min(off + chunk, p.count)
        let last = off + chunk >= p.count
        s.push(UnsafeRawBufferPointer(rebasing: buf[off..<end]), ad: a, tag: last ? Sodium.tagFinal : Sodium.tagMessage, into: &out)
        off += chunk
      } while off < p.count
    }
    return out
  }

  public static func decrypt(itemKey: Data, itemId: String, index i: Int, count: Int, total: Int64, blob: Data) throws -> Data {
    let want = total == 0 ? 0 : plainLen(total, i)
    let b = Data(blob)
    guard i >= 0, i < count, count == Segments.count(total), want >= 0, b.count == cipherLen(want) else { throw CryptoError.failed("segment failed verification") }
    var key = Sodium.subkey(itemKey, CTX.itemSeg, UInt64(i))
    defer { Sodium.memzero(&key) }
    let s = try Sodium.PullStream(header: b.subdata(in: 0..<Sodium.ssHeader), key: key)
    let a = ad(itemId, i, count, total)
    var out = Data(capacity: want)
    var o = Sodium.ssHeader
    try b.withUnsafeBytes { buf in
      while true {
        let end = min(b.count, o + chunk + Sodium.ssA)
        let tag = try s.pull(UnsafeRawBufferPointer(rebasing: buf[o..<end]), ad: a, into: &out)
        o = end
        if tag == Sodium.tagFinal { break }
        if o >= b.count { throw CryptoError.failed("segment truncated") }
      }
    }
    guard o == b.count, out.count == want else { throw CryptoError.failed("segment failed verification") }
    return out
  }
}
