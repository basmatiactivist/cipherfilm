package app.cipherfilm.cfnative

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import androidx.core.content.FileProvider
import java.io.File
import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.exifinterface.media.ExifInterface
import com.sun.jna.NativeLong
import com.sun.jna.ptr.NativeLongByReference
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext

private class SodiumFailed(what: String) : CodedException("ERR_SODIUM", "$what failed", null)

/**
 * Thin bindings to libsodium with the same names and arguments as libsodium.js, so the app runs
 * the web client's crypto code unchanged; plus the few phone things only Android does well: reading shared files in
 * ranges, thumbnails, EXIF, and moving photos to the phone's trash with the system's own confirmation.
 * No cryptography is implemented here; Sodium.kt maps libsodium's C functions.
 */
class CfNativeModule : Module() {
  private val na get() = Sodium.lib
  private val resolver get() = appContext.reactContext!!.contentResolver
  private var pendingTrash: Promise? = null
  private var pendingPick: Promise? = null
  private var pendingShare: Promise? = null
  private var shared: List<Uri> = emptyList() // what the last share gave other apps access to
  /**
   * Reading the phone's photos (parts, thumbnails, EXIF, MediaStore queries) on threads of their own. Expo runs every
   * other AsyncFunction of every module on one thread, expo/fetch's request starts and response bodies included: there
   * two thumbnail decodes per file (a few hundred ms each for a phone camera's photo) held up the requests of all the
   * files under way, so three files at once went little faster than one. Four threads: at most four decodes in memory.
   */
  private val filePool = Executors.newFixedThreadPool(4)
  private val files = CoroutineScope(filePool.asCoroutineDispatcher() + SupervisorJob())

  private fun check(rc: Int, what: String) { if (rc != 0) throw SodiumFailed(what) }
  private fun n(v: Int) = NativeLong(v.toLong())
  private fun len(b: ByteArray?) = (b?.size ?: 0).toLong()
  /** Output sizes are checked before the buffer is made, instead of relying on libsodium refusing them afterwards. */
  private fun bounded(v: Int, range: IntRange, what: String) { if (v !in range) throw SodiumFailed(what) }

  /** No screenshots or screen recordings of the library, and the app switcher shows the icon, not the last screen. */
  private fun protect(activity: Activity?) {
    activity ?: return
    if (BuildConfig.TEST_BUILD &&
      runCatching { Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, "debug.cipherfilm.shots") == "1" }.getOrDefault(false)) return
    activity.runOnUiThread {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(false)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CfNative")

    Events("onModelProgress", "onShake", "onLockDue")

    OnCreate {
      protect(appContext.currentActivity)
      Shake.onShake = { sendEvent("onShake", emptyMap<String, Any>()) }
      AutoLock.onDue = { why -> sendEvent("onLockDue", mapOf("why" to why)) }
    }
    OnActivityEntersForeground { protect(appContext.currentActivity); appContext.reactContext?.let { Shake.resume(it) } }
    OnActivityEntersBackground { CfVideoView.pauseAll(); Shake.pause() }
    OnDestroy { files.cancel(); filePool.shutdown() }

    // ---- shake to lock and close (Shake.kt) ----
    Function("shakeWatch") { on: Boolean -> appContext.reactContext?.let { Shake.want(it, on) }; Unit }
    /** Closes the app and takes it out of the recent apps (after the JavaScript side has locked and wiped). */
    Function("closeApp") {
      appContext.currentActivity?.let { a -> a.runOnUiThread { a.finishAndRemoveTask() } }
      Unit
    }

    // ---- automatic lock (AutoLock.kt) ----
    Function("lockAfter") { ms: Double -> AutoLock.schedule(ms.toLong()) }
    Function("lockCancel") { AutoLock.cancel() }
    Function("watchScreen") { on: Boolean -> appContext.reactContext?.let { AutoLock.watchScreen(it, on) }; Unit }

    // ---- automatic backup (BackupNative.kt) ----
    Function("backupState") { BackupNative.state(appContext.reactContext!!) }
    AsyncFunction("mediaFolders") { BackupNative.folders(appContext.reactContext!!) }.runOnQueue(files)
    AsyncFunction("folderMedia") { bucket: String, afterId: Double, limit: Int -> BackupNative.media(appContext.reactContext!!, bucket, afterId.toLong(), limit) }.runOnQueue(files)
    AsyncFunction("countFolderAfter") { bucket: String, afterId: Double -> BackupNative.countAfter(appContext.reactContext!!, bucket, afterId.toLong()) }.runOnQueue(files)
    Function("askBatteryExemption") { BackupNative.askBatteryExemption(appContext.reactContext!!) }
    Function("openAppSettings") { BackupNative.openAppSettings(appContext.reactContext!!) }
    Function("backupNotify") { title: String, text: String, progress: Double, ongoing: Boolean -> BackupNative.notify(appContext.reactContext!!, title, text, progress, ongoing) }
    Function("backupNotifyCancel") { BackupNative.cancel(appContext.reactContext!!) }
    Function("keepRunning") { holder: String, title: String, text: String ->
      JsTimers.keep(appContext.reactContext, holder) // also when Android refuses the service: the run still needs timers
      TransferService.hold(appContext.reactContext!!, holder, title, text)
    }
    Function("letGo") { holder: String ->
      JsTimers.release(appContext.reactContext, holder)
      TransferService.release(appContext.reactContext!!, holder)
    }
    Function("keepRunningLost") { TransferService.lost() }
    // the installed version, for Account › About
    Function("appVersion") {
      val ctx = appContext.reactContext!!
      val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      mapOf("name" to (info.versionName ?: ""), "code" to (if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()).toDouble())
    }
    Function("watchNewMedia") { on: Boolean -> NewMedia.watch(appContext.reactContext!!, on) }
    Function("retryBackupSoon") { minutes: Int -> NewMedia.retrySoon(appContext.reactContext!!, minutes.toLong().coerceIn(1, 60)) }
    Function("clearCookies") {
      android.webkit.CookieManager.getInstance().apply { removeAllCookies(null); flush() }
    }

    // ---- search on the phone (Vision.kt, SearchIndex.kt, Models.kt) ----
    // the long ones run on their own threads (Lanes.kt), not on the one every module's AsyncFunctions share
    AsyncFunction("downloadModel") Coroutine { url: String, path: String, sha256: String, size: Double ->
      withContext(Lanes.files) {
        Models.download(url, File(path), sha256, size.toLong()) { done, total -> sendEvent("onModelProgress", mapOf("path" to path, "done" to done.toDouble(), "total" to total.toDouble())) }
      }
    }
    AsyncFunction("checkModel") Coroutine { path: String, sha256: String -> withContext(Lanes.files) { Models.check(File(path), sha256) } }
    AsyncFunction("visionOpen") Coroutine { dir: String, faces: Boolean, clip: String, indexes: Boolean, also: String? ->
      withContext(Lanes.vision) { Vision.open(dir, faces, clip, indexes, also) }
    }
    // after the jobs already asked for (an analysis still running finishes first); doesn't wait for them
    Function("visionClose") { Lanes.visionExecutor.execute { Vision.close() } }
    Function("visionState") { Vision.state() }
    AsyncFunction("visionAnalyze") Coroutine { jpeg: ByteArray, faces: Boolean, clips: List<String> -> withContext(Lanes.vision) { Vision.analyze(jpeg, faces, clips) } }
    AsyncFunction("visionText") Coroutine { ids: List<Int> -> withContext(Lanes.vision) { Vision.textVector(ids.toIntArray()) } }
    // no model: only decoding and cropping, next to whatever the models do
    AsyncFunction("faceCrop") Coroutine { jpeg: ByteArray, box: List<Double>, px: Int ->
      withContext(Dispatchers.Default) { if (box.size == 4) Vision.faceCrop(jpeg, box, px.coerceIn(32, 512)) else null }
    }
    AsyncFunction("indexPut") Coroutine { item: String, clip: ByteArray?, boxes: List<List<Double>>, scores: List<Double>, embs: ByteArray ->
      withContext(Lanes.index) { SearchIndex.put(item, clip, boxes, scores, embs) }
    }
    Function("indexRemove") { item: String -> SearchIndex.remove(item) }
    Function("indexHas") { item: String -> SearchIndex.has(item) }
    Function("indexCount") { SearchIndex.count() }
    Function("indexClear") { SearchIndex.clear() }
    AsyncFunction("indexSave") Coroutine { path: String, key: ByteArray, ad: ByteArray, extra: String -> withContext(Lanes.index) { SearchIndex.save(path, key, ad, extra) } }
    AsyncFunction("indexLoad") Coroutine { path: String, key: ByteArray, ad: ByteArray, faces: Boolean -> withContext(Lanes.index) { SearchIndex.load(path, key, ad, faces) } }
    AsyncFunction("indexSearch") Coroutine { query: ByteArray, limit: Int, minScore: Double -> withContext(Lanes.index) { SearchIndex.search(query, limit, minScore) } }
    AsyncFunction("indexSimilar") Coroutine { item: String, limit: Int, minScore: Double -> withContext(Lanes.index) { SearchIndex.similar(item, limit, minScore) } }
    Function("indexFacesOf") { item: String -> SearchIndex.facesOf(item) }
    AsyncFunction("indexCluster") Coroutine { threshold: Double, anchors: Map<String, List<String>>, rejects: Map<String, List<String>>, minFaces: Int ->
      withContext(Lanes.index) { SearchIndex.cluster(threshold, anchors, rejects, minFaces) }
    }
    // every photo and video on the phone, for "Free up space" (BackupNative.kt)
    AsyncFunction("phoneMedia") { BackupNative.allMedia(appContext.reactContext!!) }.runOnQueue(files)

    // ---- videos (VideoVault.kt) ----
    Function("videoSource") { server: String, id: String, key: ByteArray, size: Double, count: Int ->
      if (!Regex("^[0-9a-f]{32}$").matches(id) || key.size != 32 || !server.startsWith("https://")) throw SodiumFailed("videoSource")
      VideoVault.put(VideoVault.Source(server.trimEnd('/'), id, key.copyOf(), size.toLong(), count))
    }
    Function("forgetVideos") {
      CfVideoView.releaseAll()
      VideoVault.clear()
    }
    View(CfVideoView::class) {
      Prop("item") { view: CfVideoView, id: String? -> view.setItem(id) }
      Events("onControls", "onBuffering")
      Prop("controlsInset") { view: CfVideoView, v: List<Double>? -> view.setControlsInset(v?.getOrNull(0) ?: 0.0, v?.getOrNull(1) ?: 0.0) }
      Prop("controls") { view: CfVideoView, on: Boolean? -> view.setControls(on ?: true) }
    }

    // ---- thumbnails (Thumbs.kt) ----
    Function("thumbsSetup") { server: String, csrf: String, dir: String? -> Thumbs.setup(server, csrf, dir) }
    Function("thumbKeys") { ids: List<String>, keys: ByteArray -> Thumbs.putKeys(ids, keys) }
    Function("thumbsPrefetch") { ids: List<String> -> Thumbs.prefetch(ids) }
    Function("thumbsClearImages") { Thumbs.clearBitmaps() }
    Function("forgetThumbs") { Thumbs.clear() }
    View(CfThumbView::class) {
      Name("CfThumbView")
      Events("onFailed")
      Prop("item") { view: CfThumbView, id: String? -> view.setItem(id) }
      Prop("fit") { view: CfThumbView, fit: String? -> view.setFit(fit) }
      OnViewDidUpdateProps { view: CfThumbView -> view.load() }
      OnViewDestroys { view: CfThumbView -> view.destroy() }
    }

    // ---- libsodium (same names and argument order as libsodium.js) ----
    Function("sodium_version_string") { na.sodium_version_string() }
    Function("randombytes_buf") { size: Int -> bounded(size, 0..(16 shl 20), "randombytes"); ByteArray(size).also { na.randombytes_buf(it, n(size)) } }
    Function("memcmp") { a: ByteArray, b: ByteArray -> a.size == b.size && na.sodium_memcmp(a, b, n(a.size)) == 0 }
    Function("crypto_hash_sha256") { m: ByteArray -> ByteArray(32).also { check(na.crypto_hash_sha256(it, m, len(m)), "sha256") } }
    Function("crypto_generichash") { outLen: Int, m: ByteArray, key: ByteArray? ->
      bounded(outLen, 16..64, "generichash")
      ByteArray(outLen).also { check(na.crypto_generichash(it, n(outLen), m, len(m), key, n(key?.size ?: 0)), "generichash") }
    }
    Function("crypto_pwhash") { outLen: Int, password: ByteArray, salt: ByteArray, ops: Long, mem: Long, alg: Int ->
      if (salt.size != 16) throw SodiumFailed("pwhash salt") // the C function reads exactly 16 bytes
      bounded(outLen, 16..64, "pwhash")
      ByteArray(outLen).also { check(na.crypto_pwhash(it, outLen.toLong(), password, len(password), salt, ops, NativeLong(mem), alg), "pwhash") }
    }
    Function("crypto_kdf_derive_from_key") { outLen: Int, id: Long, ctx: String, key: ByteArray ->
      val c = ctx.toByteArray(Charsets.US_ASCII)
      if (c.size != 8 || key.size != 32) throw SodiumFailed("kdf")
      bounded(outLen, 16..64, "kdf")
      ByteArray(outLen).also { check(na.crypto_kdf_derive_from_key(it, n(outLen), id, c, key), "kdf") }
    }
    Function("crypto_box_keypair") {
      val pk = ByteArray(32); val sk = ByteArray(32)
      check(na.crypto_box_keypair(pk, sk), "box_keypair")
      mapOf("publicKey" to pk, "privateKey" to sk)
    }
    // sealed boxes: item keys from the background backup, sealed to the account's public key (src/backup.ts)
    Function("crypto_box_seal") { m: ByteArray, pk: ByteArray ->
      if (pk.size != 32) throw SodiumFailed("box_seal")
      ByteArray(m.size + 48).also { check(na.crypto_box_seal(it, m, len(m), pk), "box_seal") }
    }
    Function("crypto_box_seal_open") { c: ByteArray, pk: ByteArray, sk: ByteArray ->
      if (c.size < 48 || pk.size != 32 || sk.size != 32) throw SodiumFailed("box_seal_open")
      ByteArray(c.size - 48).also { check(na.crypto_box_seal_open(it, c, len(c), pk, sk), "box_seal_open") }
    }
    Function("crypto_scalarmult_base") { n: ByteArray ->
      if (n.size != 32) throw SodiumFailed("scalarmult_base")
      ByteArray(32).also { check(na.crypto_scalarmult_base(it, n), "scalarmult_base") }
    }
    Function("aead_encrypt") { m: ByteArray, ad: ByteArray?, nonce: ByteArray, key: ByteArray ->
      if (nonce.size != 24 || key.size != 32) throw SodiumFailed("aead_encrypt")
      ByteArray(m.size + 16).also { check(na.crypto_aead_xchacha20poly1305_ietf_encrypt(it, null, m, len(m), ad, len(ad), null, nonce, key), "aead_encrypt") }
    }
    Function("aead_decrypt") { c: ByteArray, ad: ByteArray?, nonce: ByteArray, key: ByteArray ->
      if (c.size < 16 || nonce.size != 24 || key.size != 32) throw SodiumFailed("aead_decrypt")
      ByteArray(c.size - 16).also { check(na.crypto_aead_xchacha20poly1305_ietf_decrypt(it, null, null, c, len(c), ad, len(ad), nonce, key), "aead_decrypt") }
    }
    // the 52-byte state crosses into JavaScript and back, like libsodium.js keeps it in its own heap
    Function("ss_init_push") { key: ByteArray ->
      if (key.size != 32) throw SodiumFailed("init_push")
      val st = ByteArray(Sodium.STATE_BYTES); val header = ByteArray(24)
      check(na.crypto_secretstream_xchacha20poly1305_init_push(st, header, key), "init_push")
      mapOf("state" to st, "header" to header)
    }
    Function("ss_push") { state: ByteArray, m: ByteArray, ad: ByteArray?, tag: Int ->
      if (state.size != Sodium.STATE_BYTES) throw SodiumFailed("push")
      val c = ByteArray(m.size + 17)
      check(na.crypto_secretstream_xchacha20poly1305_push(state, c, null, m, len(m), ad, len(ad), tag.toByte()), "push")
      mapOf("state" to state, "c" to c)
    }
    Function("ss_init_pull") { header: ByteArray, key: ByteArray ->
      if (header.size != 24 || key.size != 32) throw SodiumFailed("init_pull")
      ByteArray(Sodium.STATE_BYTES).also { check(na.crypto_secretstream_xchacha20poly1305_init_pull(it, header, key), "init_pull") }
    }
    Function("ss_pull") { state: ByteArray, c: ByteArray, ad: ByteArray? ->
      if (state.size != Sodium.STATE_BYTES || c.size < 17) return@Function null
      val m = ByteArray(c.size - 17); val tag = ByteArray(1)
      if (na.crypto_secretstream_xchacha20poly1305_pull(state, m, null, tag, c, len(c), ad, len(ad)) != 0) return@Function null
      mapOf("state" to state, "message" to m, "tag" to tag[0].toInt())
    }
    Function("pad") { buf: ByteArray, block: Int ->
      bounded(block, 1..65536, "pad")
      val work = buf.copyOf(buf.size + block); val out = NativeLongByReference()
      check(na.sodium_pad(out, work, n(buf.size), n(block), n(work.size)), "pad")
      work.copyOf(out.value.toInt())
    }
    Function("unpad") { buf: ByteArray, block: Int ->
      bounded(block, 1..65536, "unpad")
      val out = NativeLongByReference()
      check(na.sodium_unpad(out, buf, n(buf.size), n(block)), "unpad")
      buf.copyOf(out.value.toInt())
    }

    // ---- shared files ----
    AsyncFunction("stat") { uri: String ->
      val u = Uri.parse(uri)
      var name: String? = null; var size = -1L
      resolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
        if (it.moveToFirst()) {
          name = it.getString(0)
          if (!it.isNull(1)) size = it.getLong(1)
        }
      }
      if (size < 0) resolver.openAssetFileDescriptor(u, "r")?.use { size = it.length }
      mapOf("name" to (name ?: u.lastPathSegment ?: "file"), "size" to size, "mime" to resolver.getType(u), "deletable" to (mediaUri(u) != null))
    }.runOnQueue(files)
    AsyncFunction("readRange") { uri: String, offset: Long, length: Int ->
      resolver.openFileDescriptor(Uri.parse(uri), "r")!!.use { pfd ->
        FileInputStream(pfd.fileDescriptor).channel.use { ch ->
          ch.position(offset)
          val buf = ByteBuffer.allocate(length)
          while (buf.hasRemaining() && ch.read(buf) >= 0) { }
          if (buf.position() != length) throw CodedException("ERR_SHORT_READ", "the file is shorter than expected", null)
          buf.array()
        }
      }
    }.runOnQueue(files)
    AsyncFunction("mediaInfo") { uri: String, isVideo: Boolean ->
      val u = Uri.parse(uri)
      val out = mutableMapOf<String, Any?>()
      if (isVideo) {
        MediaMetadataRetriever().apply {
          try {
            setDataSource(appContext.reactContext, u)
            extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let { out["duration"] = it / 1000.0 }
            val w = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val h = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            val rot = extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (w != null && h != null) { out["width"] = if (rot % 180 == 0) w else h; out["height"] = if (rot % 180 == 0) h else w }
            extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)?.let { parseVideoDate(it) }?.let { out["captureTs"] = it }
          } catch (_: Exception) { } finally { release() }
        }
      } else {
        try {
          resolver.openInputStream(u)?.use { s ->
            val x = ExifInterface(s)
            val when_ = x.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: x.getAttribute(ExifInterface.TAG_DATETIME)
            when_?.let { parseExifDate(it, x.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL)) }?.let { out["captureTs"] = it }
            x.getAttribute(ExifInterface.TAG_MAKE)?.let { out["make"] = it.trim() }
            x.getAttribute(ExifInterface.TAG_MODEL)?.let { out["model"] = it.trim() }
            x.latLong?.let { out["lat"] = it[0]; out["lon"] = it[1] }
          }
        } catch (_: Exception) { }
      }
      out
    }.runOnQueue(files)
    // A JPEG no larger than maxPx on its long side, upright; images and video frames. Null if Android can't decode it.
    AsyncFunction("jpeg") { uri: String, isVideo: Boolean, maxPx: Int, quality: Int ->
      val u = Uri.parse(uri)
      val bmp: Bitmap? = try {
        if (isVideo) MediaMetadataRetriever().run {
          try {
            setDataSource(appContext.reactContext, u)
            if (Build.VERSION.SDK_INT >= 27) getScaledFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, maxPx, maxPx) else getFrameAtTime(1_000_000)
          } finally { release() }
        } else ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, u)) { dec, info, _ ->
          val long = maxOf(info.size.width, info.size.height)
          if (long > maxPx) { val f = maxPx.toDouble() / long; dec.setTargetSize(maxOf(1, (info.size.width * f).toInt()), maxOf(1, (info.size.height * f).toInt())) }
          dec.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
      } catch (_: Exception) { null }
      if (bmp == null) return@AsyncFunction null
      val long = maxOf(bmp.width, bmp.height)
      val scaled = if (long > maxPx) Bitmap.createScaledBitmap(bmp, maxOf(1, bmp.width * maxPx / long), maxOf(1, bmp.height * maxPx / long), true) else bmp
      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
      mapOf("bytes" to out.toByteArray(), "width" to bmp.width, "height" to bmp.height)
    }.runOnQueue(files)

    // ---- choosing from the phone ----
    // Android's own photo picker: no storage permission, the person sees only what they choose to give.
    AsyncFunction("pickMedia") { promise: Promise ->
      val activity = appContext.currentActivity ?: run { promise.resolve(emptyList<String>()); return@AsyncFunction }
      pendingPick?.resolve(emptyList<String>())
      pendingPick = promise
      val intent = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).apply {
        putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
      } else Intent(Intent.ACTION_GET_CONTENT).apply {
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addCategory(Intent.CATEGORY_OPENABLE)
      }
      activity.startActivityForResult(intent, PICK_REQUEST)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    // the system's long-press feedback: follows the person's vibration settings, needs no permission
    Function("elapsedRealtime") { android.os.SystemClock.elapsedRealtime().toDouble() }

    // data: URIs for decrypted images, without a character loop on the JS thread
    Function("base64") { b: ByteArray -> android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP) }

    Function("haptic") {
      val activity = appContext.currentActivity
      activity?.runOnUiThread { activity.window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
      null
    }

    // The viewer's full screen (src/immersive.ts): the status and navigation bars hidden, a swipe from the edge shows them
    // for a moment over the photo (they hide again on their own). The viewer shows them again whenever it goes.
    Function("systemBars") { hidden: Boolean ->
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) bars.hide(WindowInsetsCompat.Type.systemBars()) else bars.show(WindowInsetsCompat.Type.systemBars())
      }
      null
    }

    // ---- out of the app ----
    // Hands decrypted copies (in the app's cache, see src/outbox.ts) to another app through Android's share sheet. The
    // other app gets read access to exactly these files, nothing else; the copies are removed again later.
    AsyncFunction("shareFiles") { paths: List<String>, mimes: List<String>, promise: Promise ->
      val activity = appContext.currentActivity ?: run { promise.resolve(false); return@AsyncFunction }
      val ctx = activity.applicationContext
      val uris = paths.map { FileProvider.getUriForFile(ctx, ctx.packageName + ".SharingFileProvider", outboxFile(it)) }
      revokeShared()
      shared = uris
      val mime = mimes.distinct().singleOrNull() ?: if (mimes.all { it.startsWith("image/") }) "image/*" else if (mimes.all { it.startsWith("video/") }) "video/*" else "*/*"
      val send = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
      send.type = mime
      send.clipData = ClipData.newRawUri(null, uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      pendingShare?.resolve(false)
      pendingShare = promise
      val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(activity.componentName)) // not back into Cipherfilm itself
      activity.startActivityForResult(chooser, SHARE_REQUEST)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    // when the outbox is emptied: the apps shared with can no longer read those files, whatever they were called
    Function("revokeShared") { revokeShared() }
    // the outbox has new copies: they are removed after the grace period even if the app isn't running then (Outbox.kt)
    Function("outboxSweepLater") { appContext.reactContext?.let { Outbox.sweepLater(it.applicationContext) }; null }

    // Puts a decrypted copy into the phone's photo library (Pictures/Cipherfilm or Movies/Cipherfilm).
    AsyncFunction("saveToLibrary") { path: String, name: String, mime: String ->
      val video = mime.startsWith("video/")
      val collection = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/Cipherfilm")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = resolver.insert(collection, values) ?: throw CodedException("ERR_SAVE", "couldn't save to the photo library", null)
      try {
        resolver.openOutputStream(uri)!!.use { out -> outboxFile(path).inputStream().use { it.copyTo(out) } }
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) {
        resolver.delete(uri, null, null)
        throw e
      }
      uri.toString()
    }

    // ---- removing from the phone ----
    // Shared-in photos and "Free up space": into the phone's own trash (Android keeps it 30 days), after the system's
    // own confirmation; resolves true only if the person agreed.
    AsyncFunction("trashFromLibrary") { uris: List<String>, promise: Promise ->
      val media = uris.mapNotNull { mediaUri(Uri.parse(it)) }
      val activity = appContext.currentActivity
      if (media.isEmpty() || activity == null || Build.VERSION.SDK_INT < 30) { promise.resolve(false); return@AsyncFunction }
      pendingTrash?.resolve(false)
      pendingTrash = promise
      val req = MediaStore.createTrashRequest(resolver, media, true)
      activity.startIntentSenderForResult(req.intentSender, TRASH_REQUEST, null, 0, 0, 0)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    OnActivityResult { _, payload ->
      if (payload.requestCode == PICK_REQUEST) {
        val data = payload.data
        val uris = mutableListOf<String>()
        if (payload.resultCode == Activity.RESULT_OK && data != null) {
          data.clipData?.let { c -> for (i in 0 until c.itemCount) uris.add(c.getItemAt(i).uri.toString()) }
          if (uris.isEmpty()) data.data?.let { uris.add(it.toString()) }
        }
        pendingPick?.resolve(uris)
        pendingPick = null
      }
      if (payload.requestCode == SHARE_REQUEST) {
        pendingShare?.resolve(true)
        pendingShare = null
      }
      if (payload.requestCode == TRASH_REQUEST) {
        pendingTrash?.resolve(payload.resultCode == Activity.RESULT_OK)
        pendingTrash = null
      }
    }
  }

  /**
   * The photo library entry behind a shared or picked URI, for removing it from the phone: the library's own URI, or the
   * library entry with the local photo picker's id. Only MediaStore's own URIs count; a library URI inside another
   * app's URI names something that app never gave us. Nothing is removed on this alone: Android's trash request shows
   * the person previews of exactly these photos and needs their OK.
   */
  private fun mediaUri(u: Uri): Uri? {
    if (u.scheme != "content" || u.authority != MediaStore.AUTHORITY) return null
    val seg = u.pathSegments
    if (seg.firstOrNull()?.startsWith("picker") != true) {
      return u.takeIf { runCatching { ContentUris.parseId(it) }.isSuccess }
    }
    // content://media/picker[_get_content]/<user>/<provider>/media/<id>: only this user's photos on the phone itself
    // (the picker's cloud providers and other profiles number theirs differently)
    if (seg.size != 5 || seg[1] != (android.os.Process.myUid() / 100_000).toString() || seg[2] != PHOTO_PICKER || seg[3] != "media") return null
    val id = seg[4].toLongOrNull() ?: return null
    val video = resolver.getType(u)?.startsWith("video/") == true
    return ContentUris.withAppendedId((if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)), id)
  }

  /** Only the decrypted copies in the outbox (src/outbox.ts) ever leave the app, never another of its files. */
  private fun outboxFile(path: String): File {
    val root = File(appContext.reactContext!!.cacheDir, "cf-out").canonicalFile
    val f = File(Uri.parse(path).path ?: "").canonicalFile
    if (!f.path.startsWith(root.path + File.separator)) throw CodedException("ERR_OUTBOX", "not a file prepared for sharing", null)
    return f
  }

  private fun revokeShared() {
    val ctx = appContext.reactContext ?: return
    shared.forEach { runCatching { ctx.revokeUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
    shared = emptyList()
  }

  private fun parseExifDate(v: String, offset: String?): Long? = try {
    val f = SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US)
    if (offset != null && Regex("^[+-]\\d\\d:\\d\\d$").matches(offset)) f.timeZone = TimeZone.getTimeZone("GMT$offset")
    f.parse(v)?.time
  } catch (_: Exception) { null }

  private fun parseVideoDate(v: String): Long? = try {
    SimpleDateFormat("yyyyMMdd'T'HHmmss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(v)?.time
  } catch (_: Exception) { null }

  companion object { private const val PICK_REQUEST = 0x5057; private const val SHARE_REQUEST = 0x5058; private const val TRASH_REQUEST = 0x5059; private const val PHOTO_PICKER = "com.android.providers.media.photopicker" }
}
