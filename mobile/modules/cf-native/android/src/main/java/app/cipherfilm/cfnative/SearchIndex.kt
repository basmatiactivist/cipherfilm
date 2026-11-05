package app.cipherfilm.cfnative

/**
 * The decrypted search index, in memory only: one image vector per item and the faces in it. Searching and grouping
 * faces into people run here, off the JavaScript thread. Cleared at every lock (src/search/index.ts calls clear()).
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

  private fun dot(a: FloatArray, b: FloatArray): Float { var s = 0f; for (i in a.indices) s += a[i] * b[i]; return s }
  private fun norm(a: FloatArray): Float = kotlin.math.sqrt(dot(a, a)).takeIf { it > 0 } ?: 1f
}
