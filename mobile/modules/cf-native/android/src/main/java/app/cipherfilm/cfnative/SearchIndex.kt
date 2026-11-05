package app.cipherfilm.cfnative

import com.sun.jna.NativeLong
import java.io.File
import java.nio.ByteBuffer

/**
 * The decrypted search index, in memory: one image vector per item and the faces in it. Searching and grouping
 * faces into people run here, off the JavaScript thread. Cleared at every lock (src/search/engine.ts calls clear()).
 * For a fast unlock, save() keeps a copy on the phone encrypted with a key derived from the master key (only the
 * unlocked app has it), and load() reads it back after the next unlock instead of opening every entry again.
 */
internal object SearchIndex {
  private val rows = HashMap<String, Int>()
  private val ids = ArrayList<String>()
  private var vecs = FloatArray(1024 * Vision.CLIP_DIM)

  private class FaceRec(val key: String, val item: String, val emb: FloatArray, val score: Float, val size: Float, val box: List<Double>)
  private val faces = LinkedHashMap<String, FaceRec>()
  private val facesByItem = HashMap<String, MutableList<String>>()

  @Synchronized fun clear() {
    rows.clear(); ids.clear(); vecs = FloatArray(1024 * Vision.CLIP_DIM)
    faces.clear(); facesByItem.clear()
  }

  @Synchronized fun count() = mapOf("items" to ids.size, "faces" to faces.size)

  /** clip: float16 vector; per face its box (0..1), score and float16 vector (all vectors in one array). Replaces what
   *  the item had. */
  @Synchronized fun put(item: String, clip: ByteArray?, boxes: List<List<Double>>, scores: List<Double>, embs: ByteArray) {
    val each = Vision.FACE_DIM * 2
    val itemFaces = boxes.indices.filter { (it + 1) * each <= embs.size && it < scores.size }
      .map { mapOf("box" to boxes[it], "score" to scores[it], "emb" to embs.copyOfRange(it * each, (it + 1) * each)) }
    if (clip != null && clip.size == Vision.CLIP_DIM * 2) {
      val v = Vision.unhalf(clip)
      val row = rows[item] ?: ids.size.also { r ->
        if ((r + 1) * Vision.CLIP_DIM > vecs.size) vecs = vecs.copyOf(vecs.size * 2)
        ids.add(item); rows[item] = r
      }
      System.arraycopy(v, 0, vecs, row * Vision.CLIP_DIM, Vision.CLIP_DIM)
    }
    facesByItem.remove(item)?.forEach { faces.remove(it) }
    itemFaces.forEachIndexed { k, f ->
      val emb = (f["emb"] as? ByteArray)?.takeIf { it.size == Vision.FACE_DIM * 2 } ?: return@forEachIndexed
      @Suppress("UNCHECKED_CAST") val box = (f["box"] as? List<Double>) ?: return@forEachIndexed
      if (box.size != 4) return@forEachIndexed
      val key = "$item:$k"
      faces[key] = FaceRec(key, item, Vision.unhalf(emb), (f["score"] as? Double)?.toFloat() ?: 0f, maxOf(box[2], box[3]).toFloat(), box)
      facesByItem.getOrPut(item) { mutableListOf() }.add(key)
    }
  }

  @Synchronized fun remove(item: String) {
    facesByItem.remove(item)?.forEach { faces.remove(it) }
    val row = rows.remove(item) ?: return
    val last = ids.size - 1
    if (row != last) { // move the last row into the gap
      val moved = ids[last]
      System.arraycopy(vecs, last * Vision.CLIP_DIM, vecs, row * Vision.CLIP_DIM, Vision.CLIP_DIM)
      ids[row] = moved; rows[moved] = row
    }
    ids.removeAt(last)
  }

  @Synchronized fun has(item: String) = rows.containsKey(item)

  /** Items whose image vector is closest to the query vector (float32), best first. */
  @Synchronized fun search(query: ByteArray, limit: Int, minScore: Double): List<Map<String, Any>> {
    val q = Vision.unfloats(query)
    if (q.size != Vision.CLIP_DIM) return emptyList()
    return top(q, limit, minScore, null)
  }

  /** Items that look like this one. */
  @Synchronized fun similar(item: String, limit: Int, minScore: Double): List<Map<String, Any>> {
    val row = rows[item] ?: return emptyList()
    val q = vecs.copyOfRange(row * Vision.CLIP_DIM, (row + 1) * Vision.CLIP_DIM)
    return top(q, limit, minScore, item)
  }

  private fun top(q: FloatArray, limit: Int, minScore: Double, skip: String?): List<Map<String, Any>> {
    val scores = FloatArray(ids.size)
    for (r in ids.indices) {
      var s = 0f; val o = r * Vision.CLIP_DIM
      for (i in 0 until Vision.CLIP_DIM) s += vecs[o + i] * q[i]
      scores[r] = s
    }
    return ids.indices.filter { scores[it] >= minScore && ids[it] != skip }.sortedByDescending { scores[it] }.take(limit)
      .map { mapOf("id" to ids[it], "score" to scores[it].toDouble()) }
  }

  @Synchronized fun facesOf(item: String): List<Map<String, Any>> =
    facesByItem[item].orEmpty().mapNotNull { faces[it] }.map { mapOf("key" to it.key, "box" to it.box, "score" to it.score.toDouble()) }

  /**
   * Groups faces into people. Faces too small or unclear to compare well are left out. Greedy clustering against each
   * group's running mean; groups whose means are close are joined. The person's own choices win: faces they named
   * (anchors) pull their groups together under that person, faces they took out (rejects) are never in it.
   */
  @Synchronized fun cluster(threshold: Double, anchors: Map<String, List<String>>, rejects: Map<String, List<String>>, minFaces: Int): List<Map<String, Any?>> {
    val usable = faces.values.filter { it.score >= 0.86f && it.size >= 0.04f }.sortedByDescending { it.score * it.size }
    val means = ArrayList<FloatArray>(); val members = ArrayList<MutableList<FaceRec>>()
    val t = threshold.toFloat()
    for (f in usable) {
      var best = -1; var bestS = t
      for (c in means.indices) {
        val s = dot(means[c], f.emb) / norm(means[c])
        if (s > bestS) { bestS = s; best = c }
      }
      if (best < 0) { means.add(f.emb.copyOf()); members.add(mutableListOf(f)) }
      else { val m = means[best]; for (i in m.indices) m[i] += f.emb[i]; members[best].add(f) }
    }
    // join groups whose means are close: the same person seen in different light or years
    val parent = IntArray(means.size) { it }
    fun find(x: Int): Int { var y = x; while (parent[y] != y) y = parent[y]; return y }
    val unit = means.map { m -> val n = norm(m); FloatArray(m.size) { m[it] / n } }
    for (a in unit.indices) for (b in a + 1 until unit.size) if (dot(unit[a], unit[b]) > t + 0.05f) parent[find(b)] = find(a)
    // named people: every group holding one of their faces is theirs
    val group = HashMap<String, Int>()
    members.forEachIndexed { c, list -> list.forEach { group[it.key] = c } }
    val owner = HashMap<Int, String>()
    for ((person, keys) in anchors) {
      val gs = keys.mapNotNull { group[it] }.map { find(it) }.distinct()
      if (gs.isEmpty()) continue
      gs.drop(1).forEach { parent[find(it)] = find(gs[0]) }
      owner.putIfAbsent(find(gs[0]), person)
    }
    val rejected = rejects.mapValues { it.value.toSet() }
    // a face given to a person (an anchor) is theirs even where the grouping put it with someone else ("move to");
    // the same rule as the Mac app (mac/Sources/CipherfilmCore/SearchIndex.swift)
    val anchorOwner = HashMap<String, String>()
    for ((person, keys) in anchors) for (k in keys) if (k !in anchorOwner && k !in rejected[person].orEmpty()) anchorOwner[k] = person
    val rootOf = HashMap<String, Int>()
    for ((r, p) in owner) rootOf.putIfAbsent(p, r)
    val buckets = LinkedHashMap<String, MutableList<FaceRec>>()
    val bucketPerson = HashMap<String, String>()
    fun add(b: String, f: FaceRec, person: String?) {
      if (b !in buckets && person != null) bucketPerson[b] = person
      buckets.getOrPut(b) { mutableListOf() }.add(f)
    }
    members.forEachIndexed { c, list ->
      val r = find(c)
      for (f in list) {
        val p = anchorOwner[f.key]
        if (p != null && owner[r] != p) { val pr = rootOf[p]; if (pr != null) add("r$pr", f, p) else add("p$p", f, p) }
        else add("r$r", f, owner[r])
      }
    }
    return buckets.map { (b, list) ->
      val person = bucketPerson[b]
      val no = person?.let { rejected[it] }.orEmpty()
      val kept = list.filter { it.key !in no }
      val cover = kept.maxByOrNull { it.score * it.size }
      mapOf(
        "person" to person,
        "faces" to kept.map { it.key },
        "items" to kept.map { it.item }.distinct(),
        "cover" to cover?.let { mapOf("key" to it.key, "item" to it.item, "box" to it.box) },
      )
    }.filter { (it["items"] as List<*>).size >= minFaces || it["person"] != null }
      .sortedByDescending { (it["items"] as List<*>).size }
  }

  // ---- the encrypted copy on the phone ----

  private val MAGIC = byteArrayOf(0x43, 0x46, 0x53, 0x31) // "CFS1"
  private const val NONCE = 24
  private const val MAC = 16

  /**
   * Writes the index to path, encrypted (XChaCha20-Poly1305) under key and bound to ad; extra (the app's list of which
   * entry each item has) is encrypted along with it. The plaintext exists only in memory here and is wiped, as is key.
   */
  fun save(path: String, key: ByteArray, ad: ByteArray, extra: String) {
    var plain = ByteArray(0)
    try {
      if (key.size != 32) throw IllegalArgumentException("key")
      plain = synchronized(this) { serialize(extra) }
      val nonce = ByteArray(NONCE).also { Sodium.lib.randombytes_buf(it, NativeLong(NONCE.toLong())) }
      val c = ByteArray(plain.size + MAC)
      if (Sodium.lib.crypto_aead_xchacha20poly1305_ietf_encrypt(c, null, plain, plain.size.toLong(), ad, ad.size.toLong(), null, nonce, key) != 0) throw IllegalStateException("encrypt")
      val f = File(path)
      f.parentFile?.mkdirs()
      val tmp = File(f.parentFile, ".${f.name}.tmp")
      tmp.outputStream().use { it.write(MAGIC); it.write(nonce); it.write(c) }
      if (!tmp.renameTo(f)) { tmp.delete(); throw IllegalStateException("rename") }
    } finally {
      plain.fill(0); key.fill(0)
    }
  }

  /**
   * Replaces the index with what save() wrote and returns its extra; null (index unchanged) when there is no copy or
   * it doesn't open with this key and ad (another account or model, or damaged). withFaces = false leaves faces out.
   */
  fun load(path: String, key: ByteArray, ad: ByteArray, withFaces: Boolean): String? {
    try {
      if (key.size != 32) return null
      val f = File(path)
      if (!f.exists()) return null
      val all = f.readBytes()
      if (all.size < MAGIC.size + NONCE + MAC || !all.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) return null
      val nonce = all.copyOfRange(MAGIC.size, MAGIC.size + NONCE)
      val c = all.copyOfRange(MAGIC.size + NONCE, all.size)
      val plain = ByteArray(c.size - MAC)
      if (Sodium.lib.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, null, c, c.size.toLong(), ad, ad.size.toLong(), nonce, key) != 0) return null
      try {
        return synchronized(this) { deserialize(plain, withFaces) }
      } finally {
        plain.fill(0)
      }
    } catch (e: Exception) {
      return null // a copy that doesn't read is made again from the server's entries
    } finally {
      key.fill(0)
    }
  }

  private fun utf(s: String) = s.toByteArray(Charsets.UTF_8)

  // extra; items (id, image vector as float16); faces (key, item, score, box, vector as float16)
  private fun serialize(extra: String): ByteArray {
    val ex = utf(extra)
    val idBytes = ids.map { utf(it) }
    val faceRecs = faces.values.toList()
    val faceBytes = faceRecs.map { utf(it.key) to utf(it.item) }
    val size = 4 + ex.size + 4 + idBytes.sumOf { 2 + it.size + Vision.CLIP_DIM * 2 } +
      4 + faceBytes.sumOf { (k, i) -> 2 + k.size + 2 + i.size + 4 + 4 * 8 + Vision.FACE_DIM * 2 }
    val out = ByteArray(size)
    val b = ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    b.putInt(ex.size); b.put(ex)
    b.putInt(ids.size)
    for (r in ids.indices) {
      b.putShort(idBytes[r].size.toShort()); b.put(idBytes[r])
      for (i in 0 until Vision.CLIP_DIM) b.putShort(android.util.Half.toHalf(vecs[r * Vision.CLIP_DIM + i]))
    }
    b.putInt(faceRecs.size)
    faceRecs.forEachIndexed { n, f ->
      val (k, i) = faceBytes[n]
      b.putShort(k.size.toShort()); b.put(k)
      b.putShort(i.size.toShort()); b.put(i)
      b.putFloat(f.score)
      for (x in 0 until 4) b.putDouble(f.box.getOrElse(x) { 0.0 })
      for (x in f.emb) b.putShort(android.util.Half.toHalf(x))
    }
    return out
  }

  private fun deserialize(plain: ByteArray, withFaces: Boolean): String {
    val b = ByteBuffer.wrap(plain).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    fun str(n: Int): String { val a = ByteArray(n); b.get(a); return String(a, Charsets.UTF_8) }
    val extra = str(b.int)
    val n = b.int
    if (n < 0 || n.toLong() * Vision.CLIP_DIM * 2 > plain.size) throw IllegalStateException("bad copy")
    val newIds = ArrayList<String>(n)
    val newRows = HashMap<String, Int>(n * 2)
    var newVecs = FloatArray(maxOf(1024, n) * Vision.CLIP_DIM)
    for (r in 0 until n) {
      val id = str(b.short.toInt() and 0xffff)
      for (i in 0 until Vision.CLIP_DIM) newVecs[r * Vision.CLIP_DIM + i] = android.util.Half.toFloat(b.short)
      newRows[id] = r; newIds.add(id)
    }
    val m = b.int
    val newFaces = LinkedHashMap<String, FaceRec>()
    val newByItem = HashMap<String, MutableList<String>>()
    for (x in 0 until m) {
      val key = str(b.short.toInt() and 0xffff)
      val item = str(b.short.toInt() and 0xffff)
      val score = b.float
      val box = List(4) { b.double }
      val emb = FloatArray(Vision.FACE_DIM) { android.util.Half.toFloat(b.short) }
      if (!withFaces) continue
      newFaces[key] = FaceRec(key, item, emb, score, maxOf(box[2], box[3]).toFloat(), box)
      newByItem.getOrPut(item) { mutableListOf() }.add(key)
    }
    clear()
    ids.addAll(newIds); rows.putAll(newRows); vecs = newVecs
    faces.putAll(newFaces); facesByItem.putAll(newByItem)
    return extra
  }

  private fun dot(a: FloatArray, b: FloatArray): Float { var s = 0f; for (i in a.indices) s += a[i] * b[i]; return s }
  private fun norm(a: FloatArray): Float = kotlin.math.sqrt(dot(a, a)).takeIf { it > 0 } ?: 1f
}
