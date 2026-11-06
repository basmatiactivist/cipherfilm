package app.cipherfilm.cfnative

import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads the search models from Hugging Face, where they are published, at the URL pinned in the shared list
 * (server/models.json). A file is kept only if its SHA-256 is the one built into the app. An interrupted download
 * continues where it stopped (Range), however often the connection drops or stalls, as long as it keeps getting
 * somewhere: it gives up only after 12 tries in a row without a single byte.
 */
internal object Models {
  private const val STALL_MS = 60_000L // a connection that brings less than STALL_BYTES in this long is dropped
  private const val STALL_BYTES = 64 * 1024L

  fun check(f: File, sha256: String): Boolean = f.isFile && hash(f) == sha256.lowercase()

  fun download(url: String, dest: File, sha256: String, size: Long, progress: (Long, Long) -> Unit): Boolean {
    if (!url.startsWith("https://")) throw CodedException("ERR_MODEL", "models are only downloaded over https", null)
    if (check(dest, sha256)) return true
    dest.parentFile?.mkdirs()
    val part = File(dest.path + ".part")
    if (part.length() > size) part.delete()
    var tries = 0
    while (true) {
      val have = part.length()
      if (have == size) break // complete; the hash below decides
      var c: HttpURLConnection? = null
      try {
        c = open(url, have)
        val code = c.responseCode
        // a busy CDN or a hiccup on the way is waited for, like a dropped connection
        if (code == 408 || code == 429 || code >= 500) throw java.io.IOException("Hugging Face answered $code")
        if (code == 416) { part.delete(); throw java.io.IOException("the file changed, starting again") }
        if (code != 200 && code != 206) throw CodedException("ERR_MODEL", "Hugging Face answered $code", null)
        val append = code == 206
        var done = if (append) have else 0L
        c.inputStream.use { inp ->
          FileOutputStream(part, append).use { out ->
            val buf = ByteArray(256 * 1024)
            var last = 0L
            var window = System.currentTimeMillis()
            var inWindow = 0L
            while (true) {
              val n = inp.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              done += n
              inWindow += n
              if (done > size) throw CodedException("ERR_MODEL", "the file is larger than expected", null)
              if (done - last > 1_000_000) { progress(done, size); last = done }
              // a trickle is a stall too: a new connection usually gets a faster path
              val now = System.currentTimeMillis()
              if (now - window >= STALL_MS) {
                if (inWindow < STALL_BYTES) throw java.io.IOException("the download stalled")
                window = now; inWindow = 0
              }
            }
          }
        }
        progress(done, size)
        if (done < size) throw java.io.IOException("the connection ended early") // resumed below
        break
      } catch (e: CodedException) {
        part.delete(); throw e
      } catch (e: Exception) {
        if (part.length() > have) tries = 0 // it got somewhere: the count starts again
        if (++tries >= 12) throw CodedException("ERR_MODEL", "download failed: ${e.message}", e)
        Thread.sleep(minOf(30_000L, 1000L shl tries)) // 2, 4, 8, 16, then 30 s
      } finally {
        c?.disconnect()
      }
    }
    if (hash(part) != sha256.lowercase()) {
      part.delete()
      throw CodedException("ERR_MODEL", "the downloaded file is not the expected one", null)
    }
    if (!part.renameTo(dest)) throw CodedException("ERR_MODEL", "couldn't save the model", null)
    return true
  }

  /**
   * Opens the pinned URL, following Hugging Face's redirects to its CDN by hand: each hop must stay on https and keeps
   * the Range header. Every try starts again from the pinned URL, as the CDN's signed links expire. No cookie or other
   * header of the app goes along; Hugging Face sees a plain download.
   */
  private fun open(url: String, have: Long): HttpURLConnection {
    var at = URL(url)
    repeat(6) {
      if (at.protocol != "https") throw CodedException("ERR_MODEL", "models are only downloaded over https", null)
      val c = at.openConnection() as HttpURLConnection
      c.connectTimeout = 20_000; c.readTimeout = 30_000 // no byte for 30 s: dropped and resumed
      c.instanceFollowRedirects = false
      c.useCaches = false
      if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
      val code = c.responseCode
      if (code !in 300..399) return c
      val next = c.getHeaderField("Location")
      c.disconnect()
      if (next == null) throw java.io.IOException("a redirect without a location")
      at = URL(at, next)
    }
    throw java.io.IOException("too many redirects")
  }

  private fun hash(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { s ->
      val buf = ByteArray(1 shl 20)
      while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }
}
