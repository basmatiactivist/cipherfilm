package app.cipherfilm.cfnative

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.graphics.Bitmap
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Text in photos (docs/SEARCH.md "Text in photos"): PP-OCRv3's text detector finds the lines, PP-OCRv5's Latin
 * recogniser reads each. The same steps as scripts/ocr-reference.py, constant for constant, so every app finds the same
 * text: change one, change all (and OCR_TAG in web/src/crypto/search.ts). Reads decoded pictures from memory and returns
 * the text; nothing is written and nothing leaves the phone. The three files are downloaded after the person agreed and
 * checked against their SHA-256 (src/search/models.ts) before they are opened here. Runs on the vision lane (Lanes.kt),
 * one picture at a time.
 */
internal object Ocr {
  private const val DET_SIDE = 960 // the longest side the detector sees (multiples of 32)
  private val DET_MEAN = floatArrayOf(0.485f, 0.456f, 0.406f) // applied in BGR order, as in the reference
  private val DET_STD = floatArrayOf(0.229f, 0.224f, 0.225f)
  private const val BIN = 0.3f // a pixel is text above this
  private const val BOX = 0.6 // a region is kept when its mean is at least this
  private const val UNCLIP = 1.5 // regions grow by area * UNCLIP / perimeter on every side
  private const val MIN_SIDE = 3 // regions smaller than this (detector pixels) are dropped
  private const val REC_H = 48
  private const val REC_MAX_W = 960 // a line wider than this (after scaling to 48 px high) is squeezed
  private const val REC_MIN_SCORE = 0.5 // a line's mean character confidence
  private const val MAX_LINES = 40

  const val DET = "ocr-det-v3.onnx"
  const val REC = "ocr-rec-latin-v5.onnx"
  const val DICT = "ocr-latin-dict.txt"

  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment().also { runCatching { it.setTelemetry(false) } } }
  private var det: OrtSession? = null
  private var rec: OrtSession? = null
  private var chars: List<String> = emptyList()
  private var dir: File? = null

  private fun opts() = OrtSession.SessionOptions().apply {
    setIntraOpNumThreads(2) // as the reference, and as the other models: the phone stays usable
    setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
  }

  @Volatile private var opened = false
  /** Whether the text models are open (read on the JS thread, never waits for the lock). */
  fun isOpen(): Boolean = opened

  @Synchronized fun open(path: String) {
    val d = File(path)
    if (dir == d && det != null && rec != null) return
    close()
    try {
      // the dictionary as Python reads it (universal newlines): one character per line, the last line ends the file
      val lines = File(d, DICT).readText(Charsets.UTF_8).replace("\r\n", "\n").replace('\r', '\n').split("\n").toMutableList()
      if (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
      chars = lines
      det = env.createSession(File(d, DET).path, opts())
      rec = env.createSession(File(d, REC).path, opts())
      dir = d
      opened = true
    } catch (e: Throwable) {
      close()
      throw e
    }
  }

  @Synchronized fun close() {
    runCatching { det?.close() }; runCatching { rec?.close() }
    det = null; rec = null; dir = null; chars = emptyList(); opened = false
  }

  /** The text in a picture: lines in reading order joined with spaces, whitespace collapsed; "" when there is none. */
  @Synchronized fun read(bmp: Bitmap): String {
    val d = det ?: throw IllegalStateException("text models not loaded")
    val r = rec ?: throw IllegalStateException("text models not loaded")
    val w = bmp.width; val h = bmp.height
    val px = IntArray(w * h)
    bmp.getPixels(px, 0, w, 0, 0, w, h)
    val img = Rgb(px, w, h)

    // the detector: longest side to at most 960, each side a multiple of 32 (Python's round: half to even)
    val s = min(1.0, DET_SIDE.toDouble() / max(w, h))
    val nw = max(32, Math.rint(w * s / 32).toInt() * 32)
    val nh = max(32, Math.rint(h * s / 32).toInt() * 32)
    val sized = resize(img, nw, nh)
    val n = nw * nh
    val buf = FloatBuffer.allocate(3 * n)
    for (i in 0 until n) {
      val p = sized.px[i]
      val rr = ((p shr 16) and 255) / 255f; val gg = ((p shr 8) and 255) / 255f; val bb = (p and 255) / 255f
      // BGR, with the mean and std in that order
      buf.put(i, (bb - DET_MEAN[0]) / DET_STD[0]); buf.put(n + i, (gg - DET_MEAN[1]) / DET_STD[1]); buf.put(2 * n + i, (rr - DET_MEAN[2]) / DET_STD[2])
    }
    val prob = FloatArray(n)
    OnnxTensor.createTensor(env, buf, longArrayOf(1, 3, nh.toLong(), nw.toLong())).use { input ->
      d.run(mapOf(inputName(d) to input)).use { res ->
        val out = (res[0] as OnnxTensor).floatBuffer
        if (out.remaining() < n) throw IllegalStateException("unexpected detector output")
        out.get(prob, 0, n)
      }
    }

    val sx = w.toDouble() / nw; val sy = h.toDouble() / nh
    val lines = mutableListOf<String>()
    for (b in regions(prob, nw, nh).take(MAX_LINES)) {
      val x0 = max(0, (b[0] * sx).toInt()); val y0 = max(0, (b[1] * sy).toInt())
      val x1 = min(w, ceil(b[2] * sx).toInt()); val y1 = min(h, ceil(b[3] * sy).toInt())
      if (x1 - x0 < 4 || y1 - y0 < 4) continue
      val (text, score) = recognise(r, crop(img, x0, y0, x1, y1))
      val t = text.trim()
      if (score >= REC_MIN_SCORE && t.isNotEmpty()) lines.add(t)
    }
    return collapse(lines.joinToString(" "))
  }

  private fun inputName(s: OrtSession) = if ("x" in s.inputNames) "x" else s.inputNames.first()

  /** Connected text pixels (4-neighbours) as boxes (x0, y0, x1, y1) in detector pixels, grown, in reading order. */
  private fun regions(prob: FloatArray, w: Int, h: Int): List<DoubleArray> {
    val seen = BooleanArray(w * h)
    val out = mutableListOf<DoubleArray>()
    val stack = IntArray(w * h)
    for (y in 0 until h) for (x in 0 until w) {
      val start = y * w + x
      if (prob[start] <= BIN || seen[start]) continue
      var top = 0
      stack[top++] = start
      seen[start] = true
      var x0 = x; var x1 = x; var y0 = y; var y1 = y
      var total = 0.0; var count = 0
      while (top > 0) {
        val c = stack[--top]
        val cy = c / w; val cx = c - cy * w
        total += prob[c]; count++
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy
        // up, down, left, right
        if (cy > 0) { val k = c - w; if (prob[k] > BIN && !seen[k]) { seen[k] = true; stack[top++] = k } }
        if (cy < h - 1) { val k = c + w; if (prob[k] > BIN && !seen[k]) { seen[k] = true; stack[top++] = k } }
        if (cx > 0) { val k = c - 1; if (prob[k] > BIN && !seen[k]) { seen[k] = true; stack[top++] = k } }
        if (cx < w - 1) { val k = c + 1; if (prob[k] > BIN && !seen[k]) { seen[k] = true; stack[top++] = k } }
      }
      val bw = x1 - x0 + 1; val bh = y1 - y0 + 1
      if (min(bw, bh) < MIN_SIDE || total / count < BOX) continue
      val d = bw.toDouble() * bh * UNCLIP / (2.0 * (bw + bh))
      out.add(doubleArrayOf(x0 - d, y0 - d, x1 + 1 + d, y1 + 1 + d))
    }
    // by line (rows of 8 detector pixels, Python's round), then from the left; stable, as Python's sort
    return out.sortedWith(compareBy<DoubleArray>({ Math.rint(it[1] / 8) }, { it[0] }))
  }

  /** One line: standing text turned to read left to right, 48 px high, BGR in -1..1; CTC greedy decoding. */
  private fun recognise(s: OrtSession, line: Rgb): Pair<String, Double> {
    var c = line
    if (c.h > c.w * 1.5) c = rotate90(c)
    val nw = max(8, min(REC_MAX_W, Math.rint(c.w.toDouble() * REC_H / c.h).toInt()))
    val sized = resize(c, nw, REC_H)
    val n = nw * REC_H
    val buf = FloatBuffer.allocate(3 * n)
    for (i in 0 until n) {
      val p = sized.px[i]
      val rr = ((p shr 16) and 255) / 255f; val gg = ((p shr 8) and 255) / 255f; val bb = (p and 255) / 255f
      buf.put(i, (bb - 0.5f) / 0.5f); buf.put(n + i, (gg - 0.5f) / 0.5f); buf.put(2 * n + i, (rr - 0.5f) / 0.5f)
    }
    OnnxTensor.createTensor(env, buf, longArrayOf(1, 3, REC_H.toLong(), nw.toLong())).use { input ->
      s.run(mapOf(inputName(s) to input)).use { res ->
        val t = res[0] as OnnxTensor
        val shape = t.info.shape // [1, T, classes]
        val steps = shape[1].toInt(); val classes = shape[2].toInt()
        val fb = t.floatBuffer
        val sb = StringBuilder()
        var sum = 0.0; var kept = 0
        var last = 0
        for (i in 0 until steps) {
          var best = 0; var bestP = fb.get(i * classes)
          for (k in 1 until classes) { val v = fb.get(i * classes + k); if (v > bestP) { bestP = v; best = k } }
          if (best != 0 && best != last) {
            sb.append(if (best - 1 < chars.size) chars[best - 1] else " ")
            sum += bestP; kept++
          }
          last = best
        }
        return sb.toString() to (if (kept > 0) sum / kept else 0.0)
      }
    }
  }

  private fun collapse(s: String): String {
    val out = StringBuilder()
    var word = false
    for (ch in s) {
      if (Character.isWhitespace(ch) || Character.isSpaceChar(ch)) { word = false; continue }
      if (!word && out.isNotEmpty()) out.append(' ')
      out.append(ch); word = true
    }
    return out.toString()
  }

  // ---- pixels: RGB as ARGB ints, resized as Pillow's BILINEAR does it (the reference's library) ----

  private class Rgb(val px: IntArray, val w: Int, val h: Int)

  private fun crop(img: Rgb, x0: Int, y0: Int, x1: Int, y1: Int): Rgb {
    val w = x1 - x0; val h = y1 - y0
    val out = IntArray(w * h)
    for (y in 0 until h) System.arraycopy(img.px, (y0 + y) * img.w + x0, out, y * w, w)
    return Rgb(out, w, h)
  }

  /** A quarter turn counter-clockwise (Pillow's ROTATE_90). */
  private fun rotate90(img: Rgb): Rgb {
    val w = img.h; val h = img.w
    val out = IntArray(w * h)
    for (y in 0 until h) for (x in 0 until w) out[y * w + x] = img.px[x * img.w + (img.w - 1 - y)]
    return Rgb(out, w, h)
  }

  private const val PRECISION = 22 // Pillow's PRECISION_BITS for 8-bit images: 32 - 8 - 2

  private class Coeffs(val size: Int, val bounds: IntArray, val k: IntArray)

  /** Pillow's precompute_coeffs and normalize_coeffs_8bpc for the triangle filter (support 1), fixed point. */
  private fun coeffs(inSize: Int, outSize: Int): Coeffs {
    val scale = inSize.toDouble() / outSize
    val filterscale = max(scale, 1.0)
    val support = 1.0 * filterscale
    val ksize = ceil(support).toInt() * 2 + 1
    val bounds = IntArray(outSize * 2)
    val kk = IntArray(outSize * ksize)
    val w = DoubleArray(ksize)
    for (xx in 0 until outSize) {
      val center = (xx + 0.5) * scale
      val ss = 1.0 / filterscale
      var xmin = (center - support + 0.5).toInt(); if (xmin < 0) xmin = 0
      var xmax = (center + support + 0.5).toInt(); if (xmax > inSize) xmax = inSize
      xmax -= xmin
      var ww = 0.0
      for (x in 0 until xmax) {
        var t = (x + xmin - center + 0.5) * ss
        if (t < 0) t = -t
        val v = if (t < 1.0) 1.0 - t else 0.0
        w[x] = v; ww += v
      }
      for (x in 0 until xmax) {
        val v = if (ww != 0.0) w[x] / ww else w[x]
        kk[xx * ksize + x] = if (v < 0) (-0.5 + v * (1 shl PRECISION)).toInt() else (0.5 + v * (1 shl PRECISION)).toInt()
      }
      bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax
    }
    return Coeffs(ksize, bounds, kk)
  }

  private fun clip8(v: Long): Int = if (v >= (1L shl PRECISION shl 8)) 255 else if (v <= 0) 0 else (v shr PRECISION).toInt()

  /** Two passes, horizontal then vertical, rounding to 8 bits in between, as Pillow's ImagingResample. */
  private fun resize(img: Rgb, nw: Int, nh: Int): Rgb {
    var cur = img
    val needH = nw != img.w; val needV = nh != img.h
    val cv = coeffs(img.h, nh)
    if (needH) {
      // only the source rows the vertical pass uses
      val first = cv.bounds[0]
      val last = cv.bounds[nh * 2 - 2] + cv.bounds[nh * 2 - 1]
      for (i in 0 until nh) cv.bounds[i * 2] -= first
      val ch = coeffs(img.w, nw)
      val rows = last - first
      val out = IntArray(nw * rows)
      val half = 1L shl (PRECISION - 1)
      for (y in 0 until rows) {
        val row = (y + first) * img.w
        for (xx in 0 until nw) {
          val xmin = ch.bounds[xx * 2]; val xmax = ch.bounds[xx * 2 + 1]; val k0 = xx * ch.size
          var r = half; var g = half; var b = half
          for (x in 0 until xmax) {
            val p = img.px[row + x + xmin]; val k = ch.k[k0 + x].toLong()
            r += ((p shr 16) and 255) * k; g += ((p shr 8) and 255) * k; b += (p and 255) * k
          }
          out[y * nw + xx] = (0xFF shl 24) or (clip8(r) shl 16) or (clip8(g) shl 8) or clip8(b)
        }
      }
      cur = Rgb(out, nw, rows)
    }
    if (needV) {
      val out = IntArray(nw * nh)
      val half = 1L shl (PRECISION - 1)
      for (yy in 0 until nh) {
        val ymin = cv.bounds[yy * 2]; val ymax = cv.bounds[yy * 2 + 1]; val k0 = yy * cv.size
        for (x in 0 until nw) {
          var r = half; var g = half; var b = half
          for (y in 0 until ymax) {
            val p = cur.px[(y + ymin) * cur.w + x]; val k = cv.k[k0 + y].toLong()
            r += ((p shr 16) and 255) * k; g += ((p shr 8) and 255) * k; b += (p and 255) * k
          }
          out[yy * nw + x] = (0xFF shl 24) or (clip8(r) shl 16) or (clip8(g) shl 8) or clip8(b)
        }
      }
      cur = Rgb(out, nw, nh)
    }
    return cur
  }
}
