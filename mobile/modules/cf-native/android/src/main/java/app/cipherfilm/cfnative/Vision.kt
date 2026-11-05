package app.cipherfilm.cfnative

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.util.Half
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * On-device search (docs/SEARCH.md): what is in a photo (MobileCLIP S2 image and text encoders, or, where an admin
 * allowed explicit search and the person chose it, LAION's uncensored CLIP ViT-B/32) and the faces in it
 * (YuNet finds them, SFace describes each one). It reads decrypted preview images from memory and returns vectors;
 * nothing is written to storage and nothing leaves the phone from here. The models are files the app downloaded from
 * its own server and checked against fixed SHA-256 values (src/search/models.ts) before they are opened.
 */
/** A picture there is nothing to see in (not an image, or a sliver): the app stores an empty entry, not tried again. */
internal class UnusableImage : CodedException("ERR_UNUSABLE_IMAGE", "not a usable picture", null)

internal object Vision {
  const val CLIP_DIM = 512
  const val FACE_DIM = 128
  private const val MIN_SIDE = 16

  /** The two image/text models: MobileCLIP S2 (256 px, 0..1) and LAION ViT-B/32 (224 px, CLIP mean and std). */
  private class Clip(val vision: String, val text: String, val px: Int, val mean: FloatArray?, val std: FloatArray?)
  private val CLIPS = mapOf(
    "mobileclip-s2" to Clip("mobileclip-s2-vision.onnx", "mobileclip-s2-text.onnx", 256, null, null),
    "laion-b32" to Clip("nsfw-laion-b32-vision.onnx", "nsfw-laion-b32-text.onnx", 224,
      floatArrayOf(0.48145466f, 0.4578275f, 0.40821073f), floatArrayOf(0.26862954f, 0.26130258f, 0.27577711f)),
  )
  private const val DET_PX = 640
  private const val FACE_SCORE = 0.82f

  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment().also { runCatching { it.setTelemetry(false) } } }
  private var dir: File? = null
  private var clipKind: Clip = CLIPS.getValue("mobileclip-s2")
  private var image: OrtSession? = null
  private var text: OrtSession? = null
  private var det: OrtSession? = null
  private var rec: OrtSession? = null

  private fun opts() = OrtSession.SessionOptions().apply {
    setIntraOpNumThreads(2) // leave the phone usable while it indexes
    setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
  }

  /** indexes = false: a phone that only searches (another device indexes) loads only the text model. */
  @Synchronized fun open(path: String, faces: Boolean, clip: String, indexes: Boolean) {
    val d = File(path)
    val k = CLIPS[clip] ?: throw IllegalArgumentException("unknown model $clip")
    if (dir != d || k !== clipKind) close()
    dir = d
    clipKind = k
    if (text == null) text = env.createSession(File(d, k.text).path, opts())
    if (!indexes) {
      listOf(image, det, rec).forEach { runCatching { it?.close() } }
      image = null; det = null; rec = null
      return
    }
    if (image == null) image = env.createSession(File(d, k.vision).path, opts())
    if (faces) {
      if (det == null) det = env.createSession(File(d, "yunet-2023mar.onnx").path, opts())
      if (rec == null) rec = env.createSession(File(d, "sface-2021dec.onnx").path, opts())
    } else {
      det?.close(); rec?.close(); det = null; rec = null
    }
  }

  @Synchronized fun close() {
    listOf(image, text, det, rec).forEach { runCatching { it?.close() } }
    image = null; text = null; det = null; rec = null; dir = null
  }

  // ---- one photo ----

  /** The image vector and the faces in a JPEG; vectors as little-endian float16. */
  fun analyze(jpeg: ByteArray, faces: Boolean): Map<String, Any> {
    val img = image ?: throw IllegalStateException("search models not loaded")
    val bmp = decode(jpeg, 1280) ?: throw UnusableImage()
    try {
      if (min(bmp.width, bmp.height) < MIN_SIDE) throw UnusableImage()
      val out = mutableMapOf<String, Any>("clip" to half(normalize(clip(img, bmp))))
      val d = det; val r = rec
      if (faces && d != null && r != null) {
        out["faces"] = detect(d, bmp).map { f ->
          mapOf(
            "box" to listOf(f.x / bmp.width, f.y / bmp.height, f.w / bmp.width, f.h / bmp.height).map { (it * 10000).roundToInt() / 10000.0 },
            "score" to (f.score * 1000).roundToInt() / 1000.0,
            "emb" to half(normalize(embed(r, bmp, f))),
          )
        }
      }
      return out
    } finally {
      bmp.recycle()
    }
  }

  /** The text vector for CLIP token ids (src/search/tokenizer.ts), little-endian float32. */
  fun textVector(ids: IntArray): ByteArray {
    val t = text ?: throw IllegalStateException("search models not loaded")
    // MobileCLIP's text model takes int64 ids, LAION's (Immich's export) int32
    val int32 = (t.inputInfo.values.first().info as? ai.onnxruntime.TensorInfo)?.type == ai.onnxruntime.OnnxJavaType.INT32
    val input = if (int32) {
      val padded = IntArray(77); ids.take(77).forEachIndexed { i, v -> padded[i] = v }
      OnnxTensor.createTensor(env, java.nio.IntBuffer.wrap(padded), longArrayOf(1, 77))
    } else {
      val padded = LongArray(77); ids.take(77).forEachIndexed { i, v -> padded[i] = v.toLong() }
      OnnxTensor.createTensor(env, LongBuffer.wrap(padded), longArrayOf(1, 77))
    }
    input.use { input ->
      t.run(mapOf(t.inputNames.first() to input)).use { res ->
        val v = (res[0].value as Array<FloatArray>)[0]
        return floats(normalize(v))
      }
    }
  }

  /** A square crop around a face from a JPEG (box in 0..1 of the image), for the people list. */
  fun faceCrop(jpeg: ByteArray, box: List<Double>, px: Int): ByteArray? {
    val bmp = decode(jpeg, 2048) ?: return null
    try {
      val cx = (box[0] + box[2] / 2) * bmp.width; val cy = (box[1] + box[3] / 2) * bmp.height
      val side = (max(box[2] * bmp.width, box[3] * bmp.height) * 1.5).coerceAtLeast(8.0)
      val l = (cx - side / 2).coerceIn(0.0, bmp.width - 1.0); val t = (cy - side / 2).coerceIn(0.0, bmp.height - 1.0)
      val s = min(side, min(bmp.width - l, bmp.height - t)).toInt().coerceAtLeast(1)
      val crop = Bitmap.createBitmap(bmp, l.toInt(), t.toInt(), s, s)
      val sized = Bitmap.createScaledBitmap(crop, px, px, true)
      val out = ByteArrayOutputStream()
      sized.compress(Bitmap.CompressFormat.JPEG, 85, out)
      if (sized !== crop) sized.recycle()
      if (crop !== bmp) crop.recycle()
      return out.toByteArray()
    } finally {
      bmp.recycle()
    }
  }

  // ---- CLIP: centre square, scaled to the model's size; MobileCLIP 0..1, LAION with CLIP's mean and std ----

  private fun clip(s: OrtSession, src: Bitmap): FloatArray {
    val k = clipKind
    val CLIP_PX = k.px
    // cropped before scaling, so a very wide or tall picture never becomes a huge bitmap on the way
    val side = min(src.width, src.height)
    val square = if (src.width == src.height) src else Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
    val sized = smooth(square, CLIP_PX, CLIP_PX)
    val px = IntArray(CLIP_PX * CLIP_PX)
    sized.getPixels(px, 0, CLIP_PX, 0, 0, CLIP_PX, CLIP_PX)
    if (sized !== square) sized.recycle()
    if (square !== src) square.recycle()
    val n = CLIP_PX * CLIP_PX
    val buf = FloatBuffer.allocate(3 * n)
    for (i in 0 until n) {
      val p = px[i]
      val r = ((p shr 16) and 255) / 255f; val g = ((p shr 8) and 255) / 255f; val b = (p and 255) / 255f
      val m = k.mean; val sd = k.std
      if (m == null || sd == null) { buf.put(i, r); buf.put(n + i, g); buf.put(2 * n + i, b) }
      else { buf.put(i, (r - m[0]) / sd[0]); buf.put(n + i, (g - m[1]) / sd[1]); buf.put(2 * n + i, (b - m[2]) / sd[2]) }
    }
    OnnxTensor.createTensor(env, buf, longArrayOf(1, 3, CLIP_PX.toLong(), CLIP_PX.toLong())).use { input ->
      s.run(mapOf(s.inputNames.first() to input)).use { return (it[0].value as Array<FloatArray>)[0] }
    }
  }

  // ---- YuNet (OpenCV zoo, 2023mar): 640x640 BGR 0..255, three strides, score = sqrt(cls * obj) ----

  private class Face(val score: Float, val x: Float, val y: Float, val w: Float, val h: Float, val pts: FloatArray)

  private fun detect(s: OrtSession, src: Bitmap): List<Face> {
    val scale = DET_PX.toFloat() / max(src.width, src.height)
    val sw = max(1, (src.width * scale).roundToInt()); val sh = max(1, (src.height * scale).roundToInt())
    val sized = smooth(src, sw, sh)
    val px = IntArray(sw * sh)
    sized.getPixels(px, 0, sw, 0, 0, sw, sh)
    if (sized !== src) sized.recycle()
    val n = DET_PX * DET_PX
    val buf = FloatBuffer.allocate(3 * n) // letterboxed at the top left, the rest black
    for (y in 0 until sh) for (x in 0 until sw) {
      val p = px[y * sw + x]; val i = y * DET_PX + x
      buf.put(i, (p and 255).toFloat()); buf.put(n + i, ((p shr 8) and 255).toFloat()); buf.put(2 * n + i, ((p shr 16) and 255).toFloat())
    }
    val found = mutableListOf<Face>()
    OnnxTensor.createTensor(env, buf, longArrayOf(1, 3, DET_PX.toLong(), DET_PX.toLong())).use { input ->
      s.run(mapOf(s.inputNames.first() to input)).use { res ->
        fun out(name: String) = (res.get(name).get().value as Array<Array<FloatArray>>)[0]
        for (st in intArrayOf(8, 16, 32)) {
          val cls = out("cls_$st"); val obj = out("obj_$st"); val bb = out("bbox_$st"); val kp = out("kps_$st")
          val cols = DET_PX / st
          for (i in cls.indices) {
            val sc = sqrt(cls[i][0].coerceIn(0f, 1f) * obj[i][0].coerceIn(0f, 1f))
            if (sc < FACE_SCORE) continue
            val r = i / cols; val c = i % cols
            val cx = (c + bb[i][0]) * st; val cy = (r + bb[i][1]) * st
            val w = exp(bb[i][2]) * st; val h = exp(bb[i][3]) * st
            val pts = FloatArray(10) { k -> ((if (k % 2 == 0) c else r) + kp[i][k]) * st / scale }
            found.add(Face(sc, (cx - w / 2) / scale, (cy - h / 2) / scale, w / scale, h / scale, pts))
          }
        }
      }
    }
    found.sortByDescending { it.score }
    val keep = mutableListOf<Face>()
    for (f in found) if (keep.none { iou(it, f) > 0.3f }) keep.add(f)
    return keep.take(30)
  }

  private fun iou(a: Face, b: Face): Float {
    val x1 = max(a.x, b.x); val y1 = max(a.y, b.y); val x2 = min(a.x + a.w, b.x + b.w); val y2 = min(a.y + a.h, b.y + b.h)
    val i = max(0f, x2 - x1) * max(0f, y2 - y1)
    return i / (a.w * a.h + b.w * b.h - i)
  }

  // ---- SFace: the face turned upright onto ArcFace's 112x112 landmark positions, RGB 0..255 ----

  private val REF = floatArrayOf(38.2946f, 51.6963f, 73.5318f, 51.5014f, 56.0252f, 71.7366f, 41.5493f, 92.3655f, 70.7299f, 92.2041f)

  private fun embed(s: OrtSession, src: Bitmap, f: Face): FloatArray {
    // least-squares similarity transform (rotation, scale, shift) from the five landmarks to the reference points
    var msx = 0f; var msy = 0f; var mdx = 0f; var mdy = 0f
    for (k in 0 until 5) { msx += f.pts[2 * k]; msy += f.pts[2 * k + 1]; mdx += REF[2 * k]; mdy += REF[2 * k + 1] }
    msx /= 5; msy /= 5; mdx /= 5; mdy /= 5
    var vr = 0f; var a = 0f; var b = 0f
    for (k in 0 until 5) {
      val sx = f.pts[2 * k] - msx; val sy = f.pts[2 * k + 1] - msy; val dx = REF[2 * k] - mdx; val dy = REF[2 * k + 1] - mdy
      vr += sx * sx + sy * sy; a += dx * sx + dy * sy; b += dy * sx - dx * sy
    }
    val norm = hypot(a, b); val scale = norm / vr; val cos = a / norm * scale; val sin = b / norm * scale
    val m = Matrix().apply { setValues(floatArrayOf(cos, -sin, mdx - (cos * msx - sin * msy), sin, cos, mdy - (sin * msx + cos * msy), 0f, 0f, 1f)) }
    val face = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)
    Canvas(face).drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    val px = IntArray(112 * 112)
    face.getPixels(px, 0, 112, 0, 0, 112, 112)
    face.recycle()
    val n = 112 * 112
    val buf = FloatBuffer.allocate(3 * n)
    for (i in 0 until n) {
      val p = px[i]
      buf.put(i, ((p shr 16) and 255).toFloat()); buf.put(n + i, ((p shr 8) and 255).toFloat()); buf.put(2 * n + i, (p and 255).toFloat())
    }
    OnnxTensor.createTensor(env, buf, longArrayOf(1, 3, 112, 112)).use { input ->
      s.run(mapOf(s.inputNames.first() to input)).use { return (it[0].value as Array<FloatArray>)[0] }
    }
  }

  // ---- helpers ----

  /** Decodes a JPEG at a power-of-two reduction that keeps its long side at least maxPx/2, upright as stored. */
  private fun decode(jpeg: ByteArray, maxPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPx) sample *= 2
    return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 })
  }

  /** Downscaling in halving steps, so a large image doesn't alias into the small model input. */
  private fun smooth(src: Bitmap, w: Int, h: Int): Bitmap {
    var cur = src
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      val next = Bitmap.createScaledBitmap(cur, cur.width / 2, cur.height / 2, true)
      if (cur !== src) cur.recycle()
      cur = next
    }
    if (cur.width == w && cur.height == h) return cur
    val out = Bitmap.createScaledBitmap(cur, w, h, true)
    if (cur !== src && cur !== out) cur.recycle()
    return out
  }

  fun normalize(v: FloatArray): FloatArray {
    var s = 0.0
    for (x in v) s += x * x
    val n = sqrt(s).toFloat().takeIf { it > 0 } ?: 1f
    return FloatArray(v.size) { v[it] / n }
  }

  fun half(v: FloatArray): ByteArray {
    val b = ByteBuffer.allocate(v.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (x in v) b.putShort(Half.toHalf(x))
    return b.array()
  }

  fun unhalf(b: ByteArray): FloatArray {
    val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    return FloatArray(b.size / 2) { Half.toFloat(bb.getShort(it * 2)) }
  }

  fun floats(v: FloatArray): ByteArray {
    val b = ByteBuffer.allocate(v.size * 4).order(ByteOrder.LITTLE_ENDIAN)
    for (x in v) b.putFloat(x)
    return b.array()
  }

  fun unfloats(b: ByteArray): FloatArray {
    val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    return FloatArray(b.size / 4) { bb.getFloat(it * 4) }
  }
}
