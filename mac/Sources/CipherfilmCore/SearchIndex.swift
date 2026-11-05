// The decrypted search index, in memory only (a port of SearchIndex.kt): one image vector per item and the faces in
// it. Searching and grouping faces into people run here. Cleared at every lock.
import Foundation

public struct Hit: Sendable, Hashable { public let id: String; public let score: Double }

public struct FaceGroup: Sendable {
  public struct Cover: Sendable, Hashable {
    public let key: String; public let item: String; public let box: [Double]
    public init(key: String, item: String, box: [Double]) { self.key = key; self.item = item; self.box = box }
  }
  public let person: String?
  public let faces: [String]
  public let items: [String]
  public let cover: Cover?
}

public final class SearchIndex: @unchecked Sendable {
  private let lock = NSLock()
  private var rows: [String: Int] = [:]
  private var ids: [String] = []
  private var vecs: [Float] = []

  private struct FaceRec { let key: String; let item: String; let emb: [Float]; let score: Float; let size: Float; let box: [Double] }
  private var faces: [String: FaceRec] = [:]
  private var faceOrder: [String] = []
  private var facesByItem: [String: [String]] = [:]

  public init() {}

  public func clear() {
    lock.withLock { rows = [:]; ids = []; vecs = []; faces = [:]; faceOrder = []; facesByItem = [:] }
  }

  public var count: (items: Int, faces: Int) { lock.withLock { (ids.count, faces.count) } }

  public func has(_ item: String) -> Bool { lock.withLock { rows[item] != nil } }

  /** Replaces what the item had: its float16 image vector and its faces (box, score, float16 vector). */
  public func put(_ item: String, clip: Data?, faces fs: [FaceFound]) {
    lock.withLock {
      if let clip, clip.count == Vision.clipDim * 2 {
        let v = Vision.unhalf(clip)
        if let r = rows[item] {
          vecs.replaceSubrange((r * Vision.clipDim)..<((r + 1) * Vision.clipDim), with: v)
        } else {
          rows[item] = ids.count; ids.append(item); vecs += v
        }
      }
      dropFaces(of: item)
      var keys: [String] = []
      for (k, f) in fs.enumerated() where f.emb.count == Vision.faceDim * 2 && f.box.count == 4 {
        let key = "\(item):\(k)"
        faces[key] = FaceRec(key: key, item: item, emb: Vision.unhalf(f.emb), score: Float(f.score), size: Float(max(f.box[2], f.box[3])), box: f.box)
        faceOrder.append(key)
        keys.append(key)
      }
      if !keys.isEmpty { facesByItem[item] = keys }
    }
  }

  /** Like Kotlin's LinkedHashMap: a face put again goes to the end of the order. */
  private func dropFaces(of item: String) {
    guard let old = facesByItem.removeValue(forKey: item) else { return }
    for k in old { faces.removeValue(forKey: k) }
    let gone = Set(old)
    faceOrder.removeAll { gone.contains($0) }
  }

  public func remove(_ item: String) {
    lock.withLock {
      dropFaces(of: item)
      guard let row = rows.removeValue(forKey: item) else { return }
      let last = ids.count - 1
      if row != last { // move the last row into the gap
        let moved = ids[last]
        vecs.replaceSubrange((row * Vision.clipDim)..<((row + 1) * Vision.clipDim), with: vecs[(last * Vision.clipDim)..<((last + 1) * Vision.clipDim)])
        ids[row] = moved; rows[moved] = row
      }
      ids.removeLast()
      vecs.removeLast(Vision.clipDim)
    }
  }

  /** Items whose image vector is closest to the query vector, best first. */
  public func search(_ q: [Float], limit: Int, minScore: Double) -> [Hit] {
    guard q.count == Vision.clipDim else { return [] }
    return lock.withLock { top(q, limit, minScore, nil) }
  }

  /** Items that look like this one. */
  public func similar(_ item: String, limit: Int, minScore: Double) -> [Hit] {
    lock.withLock {
      guard let r = rows[item] else { return [] }
      return top(Array(vecs[(r * Vision.clipDim)..<((r + 1) * Vision.clipDim)]), limit, minScore, item)
    }
  }

  private func top(_ q: [Float], _ limit: Int, _ minScore: Double, _ skip: String?) -> [Hit] {
    var scores = [Float](repeating: 0, count: ids.count)
    vecs.withUnsafeBufferPointer { v in
      q.withUnsafeBufferPointer { qp in
        for r in 0..<ids.count {
          var s: Float = 0
          let o = r * Vision.clipDim
          for i in 0..<Vision.clipDim { s += v[o + i] * qp[i] }
          scores[r] = s
        }
      }
    }
    return ids.indices.filter { Double(scores[$0]) >= minScore && ids[$0] != skip }.sorted { scores[$0] > scores[$1] }.prefix(limit)
      .map { Hit(id: ids[$0], score: Double(scores[$0])) }
  }

  public func facesOf(_ item: String) -> [(key: String, box: [Double], score: Double)] {
    lock.withLock { (facesByItem[item] ?? []).compactMap { faces[$0] }.map { ($0.key, $0.box, Double($0.score)) } }
  }

  /**
   * Groups faces into people. Faces too small or unclear to compare well are left out. Greedy clustering against each
   * group's running mean; groups whose means are close are joined. The person's own choices win: faces they named
   * (anchors) pull their groups together under that person, faces they took out (rejects) are never in it.
   */
  public func cluster(threshold: Double, anchors: [(String, [String])], rejects: [String: [String]], minFaces: Int) -> [FaceGroup] {
    lock.withLock {
      let unique = faceOrder.compactMap { faces[$0] }
      // stable sort like Kotlin's sortedByDescending
      let usable = unique.enumerated().filter { $0.element.score >= 0.86 && $0.element.size >= 0.04 }
        .sorted { a, b in a.element.score * a.element.size != b.element.score * b.element.size ? a.element.score * a.element.size > b.element.score * b.element.size : a.offset < b.offset }
        .map(\.element)
      var means: [[Float]] = []
      var members: [[FaceRec]] = []
      let t = Float(threshold)
      for f in usable {
        var best = -1
        var bestS = t
        for c in means.indices {
          let s = Self.dot(means[c], f.emb) / Self.norm(means[c])
          if s > bestS { bestS = s; best = c }
        }
        if best < 0 { means.append(f.emb); members.append([f]) } else {
          for i in means[best].indices { means[best][i] += f.emb[i] }
          members[best].append(f)
        }
      }
      // join groups whose means are close: the same person seen in different light or years
      var parent = Array(means.indices)
      func find(_ x: Int) -> Int { var y = x; while parent[y] != y { y = parent[y] }; return y }
      let unit = means.map { m -> [Float] in let n = Self.norm(m); return m.map { $0 / n } }
      for a in unit.indices { for b in (a + 1)..<max(a + 1, unit.count) where Self.dot(unit[a], unit[b]) > t + 0.05 { parent[find(b)] = find(a) } }
      // named people: every group holding one of their faces is theirs
      var group: [String: Int] = [:]
      for (c, list) in members.enumerated() { for f in list { group[f.key] = c } }
      var owner: [Int: String] = [:]
      for (person, keys) in anchors {
        var gs: [Int] = []
        for k in keys { if let g = group[k] { let r = find(g); if !gs.contains(r) { gs.append(r) } } }
        guard let first = gs.first else { continue }
        for g in gs.dropFirst() { parent[find(g)] = find(first) }
        if owner[find(first)] == nil { owner[find(first)] = person }
      }
      // a face given to a person (an anchor) is theirs even where the grouping put it with someone else: "move to"
      var anchorOwner: [String: String] = [:]
      for (person, keys) in anchors { for k in keys where anchorOwner[k] == nil && !(rejects[person]?.contains(k) ?? false) { anchorOwner[k] = person } }
      var rootOf: [String: Int] = [:]
      for (r, p) in owner where rootOf[p] == nil { rootOf[p] = r }
      var buckets: [String: [FaceRec]] = [:]
      var order: [String] = []
      var bucketPerson: [String: String] = [:]
      func add(_ b: String, _ f: FaceRec, _ person: String?) {
        if buckets[b] == nil { order.append(b); if let person { bucketPerson[b] = person } }
        buckets[b, default: []].append(f)
      }
      for (c, list) in members.enumerated() {
        let r = find(c)
        for f in list {
          if let p = anchorOwner[f.key], owner[r] != p {
            if let pr = rootOf[p] { add("r\(pr)", f, p) } else { add("p\(p)", f, p) }
          } else {
            add("r\(r)", f, owner[r])
          }
        }
      }
      return order.map { b -> FaceGroup in
        let person = bucketPerson[b]
        let no = Set(person.flatMap { rejects[$0] } ?? [])
        let kept = buckets[b]!.filter { !no.contains($0.key) }
        let cover = kept.max { $0.score * $0.size < $1.score * $1.size }
        var items: [String] = []
        var have = Set<String>()
        for f in kept where have.insert(f.item).inserted { items.append(f.item) }
        return FaceGroup(person: person, faces: kept.map(\.key), items: items, cover: cover.map { FaceGroup.Cover(key: $0.key, item: $0.item, box: $0.box) })
      }.filter { $0.items.count >= minFaces || $0.person != nil }
        .enumerated().sorted { $0.element.items.count != $1.element.items.count ? $0.element.items.count > $1.element.items.count : $0.offset < $1.offset }.map(\.element)
    }
  }

  static func dot(_ a: [Float], _ b: [Float]) -> Float { var s: Float = 0; for i in a.indices { s += a[i] * b[i] }; return s }
  static func norm(_ a: [Float]) -> Float { let n = sqrt(dot(a, a)); return n > 0 ? n : 1 }
}
