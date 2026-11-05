package app.cipherfilm.cfnative

import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloads the search models from the person's own server. A file is kept only if its SHA-256 is the one built into
 * the app; an interrupted download continues where it stopped (Range), however often the connection drops, as long
 * as it keeps getting somewhere: it gives up only after 12 tries in a row without a single byte.
 */
internal object Models {
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
      val c = URL(url).openConnection() as HttpURLConnection
      try {
        c.connectTimeout = 20_000; c.readTimeout = 60_000
        c.instanceFollowRedirects = false // the cookie below stays with the app's own server
        if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
        // the session cookie: the explicit-search models (nsfw-*) are only served to people allowed them
        runCatching { android.webkit.CookieManager.getInstance().getCookie(url) }.getOrNull()?.let { c.setRequestProperty("Cookie", it) }
        val code = c.responseCode
        // a busy or restarting server (or the proxy in front of it) is waited for, like a dropped connection
        if (code == 408 || code == 429 || code >= 500) throw java.io.IOException("the server answered $code")
        if (code != 200 && code != 206) throw CodedException("ERR_MODEL", "the server answered $code", null)
        val append = code == 206
        var done = if (append) have else 0L
        c.inputStream.use { inp ->
          FileOutputStream(part, append).use { out ->
            val buf = ByteArray(256 * 1024)
            var last = 0L
            while (true) {
              val n = inp.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              done += n
              if (done > size) throw CodedException("ERR_MODEL", "the file is larger than expected", null)
              if (done - last > 2_000_000) { progress(done, size); last = done }
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
        Thread.sleep(minOf(30_000L, 2000L * tries))
      } finally {
        c.disconnect()
      }
    }
    if (hash(part) != sha256.lowercase()) {
      part.delete()
      throw CodedException("ERR_MODEL", "the downloaded file is not the expected one", null)
    }
    if (!part.renameTo(dest)) throw CodedException("ERR_MODEL", "couldn't save the model", null)
    return true
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
