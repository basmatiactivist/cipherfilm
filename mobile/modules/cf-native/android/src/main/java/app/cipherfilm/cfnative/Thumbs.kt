package app.cipherfilm.cfnative

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.webkit.CookieManager
import com.sun.jna.NativeLong
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The library grid's thumbnails, without JavaScript: fetched many to a request (POST /api/items/thumbs, as
 * src/thumbbatch.ts does), opened here with the same single-shot AEAD as web/src/crypto/item.ts (decryptThumb: a
 * subkey "ITEMTHMB" of the item key, ad = "thumb" NUL itemId) and decoded straight into a bitmap at the size of the
 * tile. JavaScript only names the item ([CfThumbView]'s `item`).
 *
 * The app hands over the item keys while the library is unlocked ([putKeys]); only the thumbnail subkey is kept.
 * [clear] at every lock and sign-out zeroes them and drops every bitmap. On disk there is only the server's
 * ciphertext, in the same cache files library.ts keeps (cf-ct/<user>/thumb-<id>), and only after it verified.
 */
internal object Thumbs {
  private const val HEADER = 1 + 24 // version, nonce
  private const val ABYTES = 16
  private const val BATCH = 100 // the server's limit
  private const val WINDOW_MS = 15L
  private const val NETS = 3 // batch requests at the same time

  /** One view's wish for one thumbnail; [wanted] goes false when the tile scrolls away or shows another item. */
  class Ask(val id: String, val px: Int, val view: Boolean, val done: (Bitmap?) -> Unit) {
    @Volatile var wanted = true
  }

  @Volatile private var server = ""
  @Volatile private var csrf = ""
  @Volatile private var dir: File? = null
  @Volatile private var single = false // an older server without the batch endpoint
  @Volatile private var gen = 0 // goes up at every clear: work started before it is dropped
  private val keys = ConcurrentHashMap<String, ByteArray>()

  private val main = Handler(Looper.getMainLooper())
  private val disk = Executors.newFixedThreadPool(3)
  private val net = Executors.newFixedThreadPool(NETS)
  private val keyer = Executors.newSingleThreadExecutor()
  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
  }

  // decoded bitmaps by id, a few screens' worth
  private val bitmaps = object : LruCache<String, Bitmap>(((Runtime.getRuntime().maxMemory() / 4).coerceAtMost(96L shl 20)).toInt()) {
    override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
  }

  // all guarded by `this`: what is being loaded, by id, and what waits for the network (oldest first)
  private val loading = HashMap<String, MutableList<Ask>>()
  private val queue = ArrayList<String>()
  private var sending = 0

  private val listeners = mutableListOf<java.lang.ref.WeakReference<() -> Unit>>()

  fun setup(server: String, csrf: String, dir: String?) {
    this.server = server.trimEnd('/')
    this.csrf = csrf
    this.dir = dir?.let { File(if (it.startsWith("file:")) android.net.Uri.parse(it).path ?: return else it) }
  }

  /** Item keys, 32 bytes each in [ids]' order. The thumbnail subkeys are derived off the JS thread and kept unless
   *  the library locked meanwhile; the item keys are zeroed either way. */
  fun putKeys(ids: List<String>, itemKeys: ByteArray) {
    val g = gen
    keyer.execute {
      val got = HashMap<String, ByteArray>()
      try {
        if (itemKeys.size != ids.size * 32) return@execute
        val ctx = "ITEMTHMB".toByteArray(Charsets.US_ASCII)
        val k = ByteArray(32)
        ids.forEachIndexed { i, id ->
          if (keys.containsKey(id) || g != gen) return@forEachIndexed
          System.arraycopy(itemKeys, i * 32, k, 0, 32)
          val sub = ByteArray(32)
          if (Sodium.lib.crypto_kdf_derive_from_key(sub, NativeLong(32), 0, ctx, k) == 0) got[id] = sub
        }
        k.fill(0)
        synchronized(keys) { if (g == gen) keys.putAll(got) else got.values.forEach { it.fill(0) } }
      } finally {
        itemKeys.fill(0)
      }
      notifyViews() // views that waited for their key ask again
    }
  }

  fun hasKey(id: String) = keys.containsKey(id)

  fun cached(id: String): Bitmap? = bitmaps.get(id)

  /** Zeroes the keys and drops every bitmap and every wish; views blank themselves. */
  fun clear() {
    synchronized(keys) {
      gen++
      keys.values.forEach { it.fill(0) }
      keys.clear()
    }
    synchronized(this) {
      loading.clear()
      queue.clear()
    }
    bitmaps.evictAll()
    notifyViews()
  }

  /** Drops the decoded bitmaps only (the shake gesture, leaving the account screen). */
  fun clearBitmaps() {
    bitmaps.evictAll()
  }

  fun onChange(f: () -> Unit) = synchronized(listeners) { listeners.add(java.lang.ref.WeakReference(f)) }
  private fun notifyViews() {
    val fs = synchronized(listeners) { listeners.removeAll { it.get() == null }; listeners.mapNotNull { it.get() } }
    main.post { fs.forEach { it() } }
  }

  /** Called on the main thread. [Ask.done] runs on the main thread too, with null when there is no thumbnail. */
  fun request(a: Ask) {
    bitmaps.get(a.id)?.let { a.done(it); return }
    if (!keys.containsKey(a.id)) return // locked: asked again after the next unlock (notifyViews)
    val g = gen
    synchronized(this) {
      loading[a.id]?.let { it.add(a); return }
      loading[a.id] = mutableListOf(a)
    }
    disk.execute { fromDisk(a.id, g) }
  }

  /** The newest thumbnails not yet on this phone, fetched ahead into the encrypted cache only. */
  fun prefetch(ids: List<String>) {
    val d = dir ?: return
    val g = gen
    disk.execute {
      val todo = ids.filter { keys.containsKey(it) && !File(d, "thumb-$it").exists() }
      synchronized(this) {
        if (g != gen) return@execute
        // queued oldest first: what is on screen goes out before them anyway (takeChunk)
        for (id in todo.asReversed()) if (!loading.containsKey(id)) { loading[id] = mutableListOf(Ask(id, 0, false) {}); queue.add(id) }
      }
      kick()
    }
  }

  private fun wanted(id: String): Boolean = synchronized(this) { loading[id]?.any { it.wanted } == true }

  private fun fromDisk(id: String, g: Int) {
    if (g != gen || !wanted(id)) { drop(id, g); return }
    val f = dir?.let { File(it, "thumb-$id") }
    if (f != null && f.exists()) {
      val ct = try { f.readBytes() } catch (e: IOException) { null }
      if (ct != null) {
        val plain = open(id, ct)
        if (plain != null) { finish(id, g, plain); return }
        if (keys.containsKey(id)) f.delete() // a damaged copy: fetched again
      }
    }
    if (g != gen) return
    synchronized(this) { queue.add(id) }
    kick()
  }

  private fun kick() {
    synchronized(this) {
      if (sending >= NETS || queue.isEmpty()) return
      sending++
    }
    net.execute { send() }
  }

  /** What goes out next: what a view waits for, newest first, then what is fetched ahead; the rest is dropped. */
  private fun takeChunk(): List<String> = synchronized(this) {
    val out = ArrayList<String>()
    for (pass in 0..1) {
      val it = queue.listIterator(queue.size)
      while (it.hasPrevious() && out.size < BATCH) {
        val id = it.previous()
        val asks = loading[id]
        when {
          asks == null || asks.none { a -> a.wanted } -> { it.remove(); loading.remove(id) } // scrolled away
          (pass == 0) == asks.any { a -> a.view } -> { it.remove(); out.add(id) }
        }
      }
    }
    out
  }

  private fun send() {
    try {
      Thread.sleep(WINDOW_MS) // what the grid asks for within a few milliseconds goes out together
      while (true) {
        val g = gen
        val ids = takeChunk()
        if (ids.isEmpty()) break
        val got: List<ByteArray?> = try {
          if (single) ids.map { one(it) } else many(ids)
        } catch (e: Gone) {
          single = true
          ids.map { one(it) }
        } catch (e: IOException) {
          ids.map { null }
        }
        ids.forEachIndexed { i, id ->
          val ct = got[i]
          val plain = ct?.let { open(id, it) }
          if (plain == null || ct == null) { fail(id, g); return@forEachIndexed }
          keep(id, ct) // only verified ciphertext is kept
          disk.execute { finish(id, g, plain) } // decoded side by side
        }
      }
    } finally {
      synchronized(this) { sending-- }
      kick()
    }
  }

  private class Gone : IOException()

  private fun request(path: String): Request.Builder =
    Request.Builder().url(server + path).apply { CookieManager.getInstance().getCookie(server)?.let { header("Cookie", it) } }

  private fun many(ids: List<String>): List<ByteArray?> {
    val body = ids.joinToString(",", "{\"item_ids\":[", "]}") { "\"$it\"" }.toRequestBody("application/json".toMediaType())
    val req = request("/api/items/thumbs").post(body).header("X-CSRF-Token", csrf).build()
    client.newCall(req).execute().use { res ->
      if (res.code == 404 || res.code == 405) throw Gone()
      if (!res.isSuccessful) throw IOException("thumbs: HTTP ${res.code}")
      return split(res.body?.bytes() ?: throw IOException("thumbs: empty"), ids.size)
    }
  }

  private fun one(id: String): ByteArray? = try {
    client.newCall(request("/api/items/$id/thumb").build()).execute().use { res -> if (res.isSuccessful) res.body?.bytes() else null }
  } catch (e: IOException) { null }

  /** For each id in the order asked: u32 big-endian length and the ciphertext, or 0xFFFFFFFF for none. */
  fun split(b: ByteArray, n: Int): List<ByteArray?> {
    val v = ByteBuffer.wrap(b)
    val out = ArrayList<ByteArray?>(n)
    var o = 0
    repeat(n) {
      if (o + 4 > b.size) { out.add(null); return@repeat }
      val len = v.getInt(o).toLong() and 0xffffffffL
      o += 4
      if (len == 0xffffffffL) { out.add(null); return@repeat }
      if (o + len > b.size) { out.add(null); o = b.size; return@repeat }
      out.add(b.copyOfRange(o, o + len.toInt()))
      o += len.toInt()
    }
    return out
  }

  /** decryptThumb: version(1) || nonce(24) || XChaCha20-Poly1305(jpeg, ad = "thumb" NUL id). Null if it fails. */
  private fun open(id: String, blob: ByteArray): ByteArray? {
    val key = keys[id] ?: return null
    if (blob.size < HEADER + ABYTES || blob[0].toInt() != 1) return null
    val nonce = blob.copyOfRange(1, HEADER)
    val c = blob.copyOfRange(HEADER, blob.size)
    val ad = "thumb\u0000$id".toByteArray(Charsets.UTF_8)
    val m = ByteArray(c.size - ABYTES)
    val rc = Sodium.lib.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, null, c, c.size.toLong(), ad, ad.size.toLong(), nonce, key)
    if (rc != 0) { m.fill(0); return null }
    return m
  }

  private fun keep(id: String, ct: ByteArray) {
    val d = dir ?: return
    try {
      d.mkdirs()
      val tmp = File(d, ".thumb-$id.tmp")
      tmp.writeBytes(ct)
      if (!tmp.renameTo(File(d, "thumb-$id"))) tmp.delete()
    } catch (e: IOException) { /* only a cache */ }
  }

  /** Decodes for the views that wait (at the largest size one of them shows it), then zeroes the JPEG. */
  private fun finish(id: String, g: Int, plain: ByteArray) {
    try {
      val asks = synchronized(this) { if (g == gen) loading[id]?.toList() else null } ?: return
      val views = asks.filter { it.view && it.wanted }
      if (views.isEmpty()) { drop(id, g); return }
      val bmp = decode(plain, views.maxOf { if (it.px <= 0) Int.MAX_VALUE else it.px }) // 0: whole
      if (bmp != null && g == gen) bitmaps.put(id, bmp)
      deliver(id, g, bmp)
    } finally {
      plain.fill(0)
    }
  }

  private fun fail(id: String, g: Int) = deliver(id, g, null)

  private fun drop(id: String, g: Int) { synchronized(this) { if (g == gen) loading.remove(id) } }

  private fun deliver(id: String, g: Int, bmp: Bitmap?) {
    val asks = synchronized(this) { if (g == gen) loading.remove(id) else null } ?: return
    main.post { if (g == gen) asks.forEach { if (it.wanted && it.view) it.done(bmp) } }
  }

  private fun decode(jpeg: ByteArray, px: Int): Bitmap? = try {
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(jpeg))) { d, info, _ ->
      val w = info.size.width
      val h = info.size.height
      // as small as the tile allows (it is cropped to a square: the shorter side fills it), never larger than it is
      val s = if (px <= 0) 1.0 else minOf(1.0, px.toDouble() / minOf(w, h))
      if (s < 1.0) d.setTargetSize(maxOf(1, (w * s).toInt()), maxOf(1, (h * s).toInt()))
    }
  } catch (e: Exception) { null }
}
