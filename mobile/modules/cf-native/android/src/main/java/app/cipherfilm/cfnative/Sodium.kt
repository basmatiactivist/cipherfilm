package app.cipherfilm.cfnative

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.NativeLong
import com.sun.jna.ptr.NativeLongByReference

/**
 * The libsodium functions the app uses, mapped one to one onto the C API of the libsodium.so built by
 * scripts/build-libsodium.sh. size_t is NativeLong (64-bit on arm64), unsigned long long is Long. The secretstream
 * state is the plain 52-byte struct, passed as a byte array.
 */
@Suppress("FunctionName", "LocalVariableName")
interface Sodium : Library {
  fun sodium_init(): Int
  fun sodium_version_string(): String
  fun randombytes_buf(buf: ByteArray, size: NativeLong)
  fun sodium_memcmp(a: ByteArray, b: ByteArray, len: NativeLong): Int
  fun sodium_pad(padded_len: NativeLongByReference, buf: ByteArray, unpadded_len: NativeLong, blocksize: NativeLong, max_len: NativeLong): Int
  fun sodium_unpad(unpadded_len: NativeLongByReference, buf: ByteArray, padded_len: NativeLong, blocksize: NativeLong): Int
  fun crypto_hash_sha256(out: ByteArray, input: ByteArray, inlen: Long): Int
  fun crypto_generichash(out: ByteArray, outlen: NativeLong, input: ByteArray, inlen: Long, key: ByteArray?, keylen: NativeLong): Int
  fun crypto_pwhash(out: ByteArray, outlen: Long, passwd: ByteArray, passwdlen: Long, salt: ByteArray, opslimit: Long, memlimit: NativeLong, alg: Int): Int
  fun crypto_kdf_derive_from_key(subkey: ByteArray, subkey_len: NativeLong, subkey_id: Long, ctx: ByteArray, key: ByteArray): Int
  fun crypto_box_keypair(pk: ByteArray, sk: ByteArray): Int
  fun crypto_box_seal(c: ByteArray, m: ByteArray, mlen: Long, pk: ByteArray): Int
  fun crypto_box_seal_open(m: ByteArray, c: ByteArray, clen: Long, pk: ByteArray, sk: ByteArray): Int
  fun crypto_scalarmult_base(q: ByteArray, n: ByteArray): Int
  fun crypto_aead_xchacha20poly1305_ietf_encrypt(c: ByteArray, clen_p: LongArray?, m: ByteArray, mlen: Long, ad: ByteArray?, adlen: Long, nsec: ByteArray?, npub: ByteArray, k: ByteArray): Int
  fun crypto_aead_xchacha20poly1305_ietf_decrypt(m: ByteArray, mlen_p: LongArray?, nsec: ByteArray?, c: ByteArray, clen: Long, ad: ByteArray?, adlen: Long, npub: ByteArray, k: ByteArray): Int
  fun crypto_secretstream_xchacha20poly1305_init_push(state: ByteArray, header: ByteArray, k: ByteArray): Int
  fun crypto_secretstream_xchacha20poly1305_push(state: ByteArray, c: ByteArray, clen_p: LongArray?, m: ByteArray, mlen: Long, ad: ByteArray?, adlen: Long, tag: Byte): Int
  fun crypto_secretstream_xchacha20poly1305_init_pull(state: ByteArray, header: ByteArray, k: ByteArray): Int
  fun crypto_secretstream_xchacha20poly1305_pull(state: ByteArray, m: ByteArray, mlen_p: LongArray?, tag_p: ByteArray, c: ByteArray, clen: Long, ad: ByteArray?, adlen: Long): Int

  companion object {
    const val STATE_BYTES = 52
    val lib: Sodium by lazy {
      Native.load("sodium", Sodium::class.java).also { check(it.sodium_init() >= 0) { "sodium_init failed" } }
    }
  }
}
