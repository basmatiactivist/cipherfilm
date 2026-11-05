package app.cipherfilm.cfnative

import android.net.Uri
import android.webkit.CookieManager
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import androidx.media3.common.PlaybackException
import com.sun.jna.NativeLong
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Plays an encrypted video without a decrypted copy anywhere but memory, and without a local server: the player reads
 * through [VaultDataSource], which fetches the encrypted 4 MiB segments the web client uploaded and opens them here,
 * exactly as web/src/crypto/file.ts does (a libsodium secretstream per segment, under a key derived for that segment,
 * with the item, index, count and size bound into every chunk). The app hands over an item's key while the library is
 * unlocked ([put]) and takes it back at every lock or sign-out ([clear]), which also drops decrypted segments.
 */
internal object VideoVault {
  class Source(val server: String, val id: String, val key: ByteArray, val size: Long, val count: Int)

  private val sources = ConcurrentHashMap<String, Source>()
  fun put(s: Source) { sources.put(s.id, s)?.let { if (it !== s) it.key.fill(0) } }
  fun get(id: String): Source? = sources[id]
  fun clear() {
    sources.values.forEach { it.key.fill(0) }
    sources.clear()
    Segments.clear()
  }

  const val SCHEME = "cfvault"
  fun uri(id: String): Uri = Uri.parse("$SCHEME://item/$id")
}

internal object Segments {
  private const val SEG = 4 * 1024 * 1024
  private const val CHUNK = 64 * 1024
  private const val HEADER = 24
  private const val ABYTES = 17
  private const val TAG_FINAL = 3
  private const val KEEP = 6 // decrypted segments kept for seeking back and forth (24 MiB)
  const val AHEAD = 2

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
  }
  private val pool = Executors.newFixedThreadPool(3)
  private val kept = LinkedHashMap<String, ByteArray>(16, 0.75f, true)
  private val loading = HashMap<String, Future<ByteArray>>()

  fun index(pos: Long) = (pos / SEG).toInt()
  fun offset(pos: Long, i: Int) = (pos - i.toLong() * SEG).toInt()

  /** Segment i, decrypted; blocks the player's loader thread until it is here. */
  fun get(src: VideoVault.Source, i: Int): ByteArray {
    val f = synchronized(this) {
      kept["${src.id}:$i"]?.let { return it }
      load(src, i)
    }
    try {
      return f.get()
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
      throw InterruptedIOException()
    } catch (e: ExecutionException) {
      throw e.cause as? IOException ?: IOException(e.cause)
    }
  }

  fun prefetch(src: VideoVault.Source, i: Int) {
    if (i < src.count) synchronized(this) { if (!kept.containsKey("${src.id}:$i")) load(src, i) }
  }

  // called with the lock held
  private fun load(src: VideoVault.Source, i: Int): Future<ByteArray> {
    val k = "${src.id}:$i"
    loading[k]?.let { return it }
    val f = pool.submit<ByteArray> {
      try {
        val plain = decrypt(src, i, fetch(src, i))
        synchronized(this) {
          if (VideoVault.get(src.id) === src) { // not locked meanwhile
            kept[k] = plain
            while (kept.size > KEEP) kept.remove(kept.keys.first())?.fill(0)
          }
        }
        plain
      } finally {
        synchronized(this) { loading.remove(k) }
      }
    }
    loading[k] = f
    return f
  }

  fun clear() = synchronized(this) {
    kept.values.forEach { it.fill(0) }
    kept.clear()
    loading.values.forEach { it.cancel(true) }
    loading.clear()
  }

  /** The session cookie is in the same cookie store the app's requests use. */
  private fun fetch(src: VideoVault.Source, i: Int): ByteArray {
    val url = "${src.server}/api/items/${src.id}/segments/$i"
    val req = Request.Builder().url(url).apply { CookieManager.getInstance().getCookie(src.server)?.let { header("Cookie", it) } }.build()
    client.newCall(req).execute().use { res ->
      if (!res.isSuccessful) throw IOException("segment $i: HTTP ${res.code}")
      return res.body?.bytes() ?: throw IOException("segment $i: empty")
    }
  }

  private fun cipherLen(p: Int) = HEADER + p + maxOf(1, (p + CHUNK - 1) / CHUNK) * ABYTES

  private fun ad(id: String, i: Int, count: Int, total: Long): ByteArray {
    val prefix = "seg\u0000$id".toByteArray(Charsets.UTF_8)
    return ByteBuffer.allocate(prefix.size + 16).put(prefix).putInt(i).putInt(count).putLong(total).array() // big-endian
  }

  private fun fail(): Nothing = throw IOException("segment failed verification")

  fun decrypt(src: VideoVault.Source, i: Int, blob: ByteArray): ByteArray {
    val total = src.size
    val want = if (total == 0L) 0 else minOf(SEG.toLong(), total - i.toLong() * SEG).toInt()
    val expectCount = maxOf(1L, (total + SEG - 1) / SEG).toInt()
    if (i < 0 || i >= src.count || src.count != expectCount || want < 0 || blob.size != cipherLen(want)) fail()
    val na = Sodium.lib
    val sub = ByteArray(32)
    val state = ByteArray(Sodium.STATE_BYTES)
    try {
      if (na.crypto_kdf_derive_from_key(sub, NativeLong(32), i.toLong(), "ITEMSEGM".toByteArray(Charsets.US_ASCII), src.key) != 0) fail()
      if (na.crypto_secretstream_xchacha20poly1305_init_pull(state, blob.copyOfRange(0, HEADER), sub) != 0) fail()
    } finally {
      sub.fill(0)
    }
    val ad = ad(src.id, i, src.count, total)
    val out = ByteArray(want)
    val tag = ByteArray(1)
    var o = HEADER
    var w = 0
    while (true) {
      val end = minOf(blob.size, o + CHUNK + ABYTES)
      if (end - o < ABYTES) fail()
      val c = blob.copyOfRange(o, end)
      val m = ByteArray(c.size - ABYTES)
      if (na.crypto_secretstream_xchacha20poly1305_pull(state, m, null, tag, c, c.size.toLong(), ad, ad.size.toLong()) != 0) fail()
      if (w + m.size > want) fail()
      System.arraycopy(m, 0, out, w, m.size)
      w += m.size
      o = end
      if (tag[0].toInt() == TAG_FINAL) break
      if (o >= blob.size) fail()
    }
    state.fill(0)
    if (o != blob.size || w != want) fail()
    return out
  }
}

/** What the player reads: the plaintext of one item, by byte position, from [Segments]. */
@UnstableApi
internal class VaultDataSource : BaseDataSource(false) {
  private var uri: Uri? = null
  private var src: VideoVault.Source? = null
  private var pos = 0L
  private var left = 0L
  private var opened = false

  override fun open(spec: DataSpec): Long {
    uri = spec.uri
    transferInitializing(spec)
    val s = spec.uri.lastPathSegment?.let { VideoVault.get(it) }
      ?: throw DataSourceException(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND)
    if (spec.position > s.size) throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
    src = s
    pos = spec.position
    left = if (spec.length != C.LENGTH_UNSET.toLong()) minOf(spec.length, s.size - pos) else s.size - pos
    opened = true
    transferStarted(spec)
    return left
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (left == 0L) return C.RESULT_END_OF_INPUT
    val s = src ?: throw IOException("closed")
    val i = Segments.index(pos)
    val plain = Segments.get(s, i)
    for (k in 1..Segments.AHEAD) Segments.prefetch(s, i + k)
    val at = Segments.offset(pos, i)
    val n = minOf(length.toLong(), left, (plain.size - at).toLong()).toInt()
    if (n <= 0) throw IOException("segment shorter than expected")
    System.arraycopy(plain, at, buffer, offset, n)
    pos += n
    left -= n
    bytesTransferred(n)
    return n
  }

  override fun getUri(): Uri? = uri

  override fun close() {
    src = null
    uri = null
    if (opened) { opened = false; transferEnded() }
  }
}
