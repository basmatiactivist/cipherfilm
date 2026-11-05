// libsodium, called directly (the Clibsodium module of swift-sodium), with the same primitives the web client uses
// through libsodium.js. Every function here is a thin wrapper: the formats built on them live in Crypto.swift.
import Clibsodium
import Foundation

public enum CryptoError: Error, Equatable, CustomStringConvertible {
  case failed(String)
  public var description: String { if case .failed(let s) = self { return s }; return "crypto error" }
}

public enum Sodium {
  private static let ready: Bool = sodium_init() >= 0

  static func ensure() { precondition(ready, "libsodium could not be initialised") }

  public static var version: String { ensure(); return String(cString: sodium_version_string()) }

  public static func random(_ n: Int) -> Data {
    ensure()
    var d = Data(count: n)
    d.withUnsafeMutableBytes { randombytes_buf($0.baseAddress!, n) }
    return d
  }

  public static func memzero(_ d: inout Data) {
    let n = d.count
    guard n > 0 else { return }
    d.withUnsafeMutableBytes { sodium_memzero($0.baseAddress!, n) }
  }

  public static func equal(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    if a.isEmpty { return true }
    return a.withUnsafeBytes { x in b.withUnsafeBytes { y in sodium_memcmp(x.baseAddress!, y.baseAddress!, a.count) == 0 } }
  }

  // ---- crypto_kdf ----

  /** crypto_kdf_derive_from_key(32, id, ctx, key): ctx is exactly 8 ASCII bytes. */
  public static func subkey(_ key: Data, _ ctx: String, _ id: UInt64) -> Data {
    ensure()
    precondition(key.count == Int(crypto_kdf_KEYBYTES) && ctx.utf8.count == 8, "bad kdf input")
    var out = Data(count: 32)
    let c = Array(ctx.utf8CString)
    out.withUnsafeMutableBytes { o in
      key.withUnsafeBytes { k in
        _ = crypto_kdf_derive_from_key(o.bindMemory(to: UInt8.self).baseAddress!, 32, id, c, k.bindMemory(to: UInt8.self).baseAddress!)
      }
    }
    return out
  }

  // ---- crypto_pwhash (Argon2id 1.3) ----

  public static func argon2id(_ password: String, salt: Data, ops: Int, mem: Int) throws -> Data {
    ensure()
    guard salt.count == Int(crypto_pwhash_SALTBYTES) else { throw CryptoError.failed("bad salt") }
    var out = Data(count: 32)
    let pw = Array(password.utf8)
    let rc = out.withUnsafeMutableBytes { o in
      salt.withUnsafeBytes { s in
        pw.withUnsafeBufferPointer { p in
          p.baseAddress!.withMemoryRebound(to: CChar.self, capacity: max(1, pw.count)) { pc in
            crypto_pwhash(o.bindMemory(to: UInt8.self).baseAddress!, 32, pc, UInt64(pw.count), s.bindMemory(to: UInt8.self).baseAddress!,
                          UInt64(ops), Int(mem), crypto_pwhash_ALG_ARGON2ID13)
          }
        }
      }
    }
    guard rc == 0 else { throw CryptoError.failed("password hashing failed (out of memory?)") }
    return out
  }

  // ---- XChaCha20-Poly1305 (IETF) AEAD ----

  public static let aeadNonce = Int(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  public static let aeadTag = Int(crypto_aead_xchacha20poly1305_ietf_ABYTES)

  public static func aeadEncrypt(_ m: Data, ad: Data, nonce: Data, key: Data) -> Data {
    ensure()
    var c = Data(count: m.count + aeadTag)
    var clen: UInt64 = 0
    c.withUnsafeMutableBytes { cb in
      m.withUnsafeBytes { mb in
        ad.withUnsafeBytes { ab in
          nonce.withUnsafeBytes { nb in
            key.withUnsafeBytes { kb in
              _ = crypto_aead_xchacha20poly1305_ietf_encrypt(
                cb.bindMemory(to: UInt8.self).baseAddress!, &clen, mb.bindMemory(to: UInt8.self).baseAddress, UInt64(m.count),
                ab.bindMemory(to: UInt8.self).baseAddress, UInt64(ad.count), nil, nb.bindMemory(to: UInt8.self).baseAddress!,
                kb.bindMemory(to: UInt8.self).baseAddress!)
            }
          }
        }
      }
    }
    return c
  }

  public static func aeadDecrypt(_ c: Data, ad: Data, nonce: Data, key: Data) throws -> Data {
    ensure()
    guard c.count >= aeadTag, nonce.count == aeadNonce, key.count == 32 else { throw CryptoError.failed("bad blob") }
    var m = Data(count: c.count - aeadTag)
    var mlen: UInt64 = 0
    let rc = m.withUnsafeMutableBytes { mb in
      c.withUnsafeBytes { cb in
        ad.withUnsafeBytes { ab in
          nonce.withUnsafeBytes { nb in
            key.withUnsafeBytes { kb in
              crypto_aead_xchacha20poly1305_ietf_decrypt(
                mb.bindMemory(to: UInt8.self).baseAddress, &mlen, nil, cb.bindMemory(to: UInt8.self).baseAddress!, UInt64(c.count),
                ab.bindMemory(to: UInt8.self).baseAddress, UInt64(ad.count), nb.bindMemory(to: UInt8.self).baseAddress!,
                kb.bindMemory(to: UInt8.self).baseAddress!)
            }
          }
        }
      }
    }
    guard rc == 0 else { throw CryptoError.failed("could not be verified") }
    return m
  }

  // ---- crypto_box_seal (X25519) ----

  public static let sealBytes = crypto_box_sealbytes()

  public static func boxSeal(_ m: Data, pk: Data) throws -> Data {
    ensure()
    guard pk.count == Int(crypto_box_PUBLICKEYBYTES) else { throw CryptoError.failed("bad public key") }
    var c = Data(count: m.count + sealBytes)
    let rc = c.withUnsafeMutableBytes { cb in
      m.withUnsafeBytes { mb in
        pk.withUnsafeBytes { pb in
          crypto_box_seal(cb.bindMemory(to: UInt8.self).baseAddress!, mb.bindMemory(to: UInt8.self).baseAddress, UInt64(m.count),
                          pb.bindMemory(to: UInt8.self).baseAddress!)
        }
      }
    }
    guard rc == 0 else { throw CryptoError.failed("seal failed") }
    return c
  }

  public static func boxSealOpen(_ c: Data, pk: Data, sk: Data) throws -> Data {
    ensure()
    guard c.count >= sealBytes, pk.count == 32, sk.count == 32 else { throw CryptoError.failed("bad blob") }
    var m = Data(count: c.count - sealBytes)
    let rc = m.withUnsafeMutableBytes { mb in
      c.withUnsafeBytes { cb in
        pk.withUnsafeBytes { pb in
          sk.withUnsafeBytes { sb in
            crypto_box_seal_open(mb.bindMemory(to: UInt8.self).baseAddress, cb.bindMemory(to: UInt8.self).baseAddress!, UInt64(c.count),
                                 pb.bindMemory(to: UInt8.self).baseAddress!, sb.bindMemory(to: UInt8.self).baseAddress!)
          }
        }
      }
    }
    guard rc == 0 else { throw CryptoError.failed("could not be verified") }
    return m
  }

  public static func scalarmultBase(_ sk: Data) -> Data {
    ensure()
    var pk = Data(count: 32)
    pk.withUnsafeMutableBytes { p in sk.withUnsafeBytes { s in _ = crypto_scalarmult_base(p.bindMemory(to: UInt8.self).baseAddress!, s.bindMemory(to: UInt8.self).baseAddress!) } }
    return pk
  }

  public static func boxKeypair() -> (pk: Data, sk: Data) {
    ensure()
    var pk = Data(count: 32), sk = Data(count: 32)
    pk.withUnsafeMutableBytes { p in sk.withUnsafeMutableBytes { s in _ = crypto_box_keypair(p.bindMemory(to: UInt8.self).baseAddress!, s.bindMemory(to: UInt8.self).baseAddress!) } }
    return (pk, sk)
  }

  // ---- hashes ----

  public static func sha256(_ d: Data) -> Data {
    ensure()
    var out = Data(count: 32)
    out.withUnsafeMutableBytes { o in d.withUnsafeBytes { b in _ = crypto_hash_sha256(o.bindMemory(to: UInt8.self).baseAddress!, b.bindMemory(to: UInt8.self).baseAddress, UInt64(d.count)) } }
    return out
  }

  /** crypto_generichash (BLAKE2b) without a key. */
  public static func genericHash(_ d: Data, length: Int) -> Data {
    ensure()
    var out = Data(count: length)
    out.withUnsafeMutableBytes { o in
      d.withUnsafeBytes { b in _ = crypto_generichash(o.bindMemory(to: UInt8.self).baseAddress!, length, b.bindMemory(to: UInt8.self).baseAddress, UInt64(d.count), nil, 0) }
    }
    return out
  }

  // ---- ISO/IEC 7816-4 padding (sodium_pad / sodium_unpad) ----

  public static func pad(_ d: Data, _ block: Int) -> Data {
    ensure()
    var buf = Data(count: d.count + block)
    buf.replaceSubrange(0..<d.count, with: d)
    var padded = 0
    let cap = buf.count
    let rc = buf.withUnsafeMutableBytes { sodium_pad(&padded, $0.bindMemory(to: UInt8.self).baseAddress!, d.count, block, cap) }
    precondition(rc == 0, "pad")
    return buf.prefix(padded)
  }

  public static func unpad(_ d: Data, _ block: Int) throws -> Data {
    ensure()
    var len = 0
    let rc = d.withUnsafeBytes { sodium_unpad(&len, $0.bindMemory(to: UInt8.self).baseAddress!, d.count, block) }
    guard rc == 0 else { throw CryptoError.failed("bad padding") }
    return d.prefix(len)
  }

  // ---- secretstream XChaCha20-Poly1305 ----

  public static let ssHeader = Int(crypto_secretstream_xchacha20poly1305_HEADERBYTES)
  public static let ssA = Int(crypto_secretstream_xchacha20poly1305_ABYTES)
  public static let tagMessage = UInt8(crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
  public static let tagFinal = UInt8(crypto_secretstream_xchacha20poly1305_TAG_FINAL)

  public final class PushStream {
    private var state = crypto_secretstream_xchacha20poly1305_state()
    public let header: Data
    public init(key: Data) {
      Sodium.ensure()
      var h = Data(count: Sodium.ssHeader)
      var st = crypto_secretstream_xchacha20poly1305_state()
      h.withUnsafeMutableBytes { hb in key.withUnsafeBytes { kb in _ = crypto_secretstream_xchacha20poly1305_init_push(&st, hb.bindMemory(to: UInt8.self).baseAddress!, kb.bindMemory(to: UInt8.self).baseAddress!) } }
      state = st
      withUnsafeMutableBytes(of: &st) { sodium_memzero($0.baseAddress!, $0.count) }
      header = h
    }
    /** Appends the ciphertext of one chunk to out. */
    public func push(_ m: UnsafeRawBufferPointer, ad: Data, tag: UInt8, into out: inout Data) {
      let start = out.count
      out.count += m.count + Sodium.ssA
      out.withUnsafeMutableBytes { ob in
        ad.withUnsafeBytes { ab in
          _ = crypto_secretstream_xchacha20poly1305_push(&state, ob.bindMemory(to: UInt8.self).baseAddress! + start, nil, m.bindMemory(to: UInt8.self).baseAddress, UInt64(m.count),
                                                         ab.bindMemory(to: UInt8.self).baseAddress, UInt64(ad.count), tag)
        }
      }
    }
    deinit { withUnsafeMutableBytes(of: &state) { sodium_memzero($0.baseAddress!, $0.count) } }
  }

  public final class PullStream {
    private var state = crypto_secretstream_xchacha20poly1305_state()
    public init(header: Data, key: Data) throws {
      Sodium.ensure()
      guard header.count == Sodium.ssHeader, key.count == 32 else { throw CryptoError.failed("bad stream header") }
      let rc = header.withUnsafeBytes { hb in key.withUnsafeBytes { kb in crypto_secretstream_xchacha20poly1305_init_pull(&state, hb.bindMemory(to: UInt8.self).baseAddress!, kb.bindMemory(to: UInt8.self).baseAddress!) } }
      guard rc == 0 else { throw CryptoError.failed("bad stream header") }
    }
    /** Decrypts one chunk, appending its plaintext to out; returns its tag. */
    public func pull(_ c: UnsafeRawBufferPointer, ad: Data, into out: inout Data) throws -> UInt8 {
      guard c.count >= Sodium.ssA else { throw CryptoError.failed("segment failed verification") }
      let start = out.count
      out.count += c.count - Sodium.ssA
      var tag: UInt8 = 0
      let rc = out.withUnsafeMutableBytes { ob in
        ad.withUnsafeBytes { ab in
          crypto_secretstream_xchacha20poly1305_pull(&state, ob.bindMemory(to: UInt8.self).baseAddress! + start, nil, &tag, c.bindMemory(to: UInt8.self).baseAddress!, UInt64(c.count),
                                                     ab.bindMemory(to: UInt8.self).baseAddress, UInt64(ad.count))
        }
      }
      guard rc == 0 else { throw CryptoError.failed("segment failed verification") }
      return tag
    }
    deinit { withUnsafeMutableBytes(of: &state) { sodium_memzero($0.baseAddress!, $0.count) } }
  }
}

// ---- encodings, as libsodium.js does them ----

public enum B64 {
  /** base64url without padding (sodium.base64_variants.URLSAFE_NO_PADDING). */
  public static func encode(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  public static func decode(_ s: String) throws -> Data {
    guard !s.contains("+"), !s.contains("/"), !s.contains("=") else { throw CryptoError.failed("bad base64") }
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    if t.count % 4 == 1 { throw CryptoError.failed("bad base64") }
    while t.count % 4 != 0 { t += "=" }
    guard let d = Data(base64Encoded: t) else { throw CryptoError.failed("bad base64") }
    return d
  }
}

public enum Hex {
  public static func encode(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

  public static func decode(_ s: String) throws -> Data {
    let u = Array(s.utf8)
    guard u.count % 2 == 0 else { throw CryptoError.failed("bad hex") }
    var out = Data(capacity: u.count / 2)
    func v(_ c: UInt8) throws -> UInt8 {
      switch c {
      case 48...57: return c - 48
      case 97...102: return c - 87
      case 65...70: return c - 55
      default: throw CryptoError.failed("bad hex")
      }
    }
    var i = 0
    while i < u.count { out.append(try v(u[i]) << 4 | v(u[i + 1])); i += 2 }
    return out
  }
}
