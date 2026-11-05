// CLIP's byte-level BPE tokenizer (the one MobileCLIP uses), a port of mobile/src/search/tokenizer.ts: lowercase, split
// into words, numbers and punctuation, then merge byte pairs in rank order. Context of 77: start, at most 75, end.
import Foundation

public final class Tokenizer: @unchecked Sendable {
  static let start = 49406, end = 49407, maxLen = 77

  private let vocab: [String: Int]
  private var ranks: [String: Int] = [:]
  private let bytes: [String]
  private var cache: [String: [Int]] = [:]
  private let lock = NSLock()

  public init(json: Data) throws {
    guard let root = try JSONSerialization.jsonObject(with: json) as? [String: Any], let model = root["model"] as? [String: Any],
          let vocab = model["vocab"] as? [String: Int], let merges = model["merges"] as? [Any] else { throw CryptoError.failed("bad tokenizer file") }
    self.vocab = vocab
    for (i, m) in merges.enumerated() {
      if let s = m as? String { ranks[s] = i } else if let p = m as? [String] { ranks[p.joined(separator: " ")] = i }
    }
    // GPT-2's mapping of bytes to printable characters, so a word's UTF-8 bytes become vocabulary keys
    var keep = Set<Int>()
    for b in 33...126 { keep.insert(b) }
    for b in 161...172 { keep.insert(b) }
    for b in 174...255 { keep.insert(b) }
    var out = [String](repeating: "", count: 256)
    var n = 0
    for b in 0..<256 {
      if keep.contains(b) { out[b] = String(UnicodeScalar(UInt8(b))) } else { out[b] = String(UnicodeScalar(UInt32(256 + n))!); n += 1 }
    }
    bytes = out
  }

  static func letter(_ c: Unicode.Scalar) -> Bool {
    switch c.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
    default: return false
    }
  }

  static func digit(_ c: Unicode.Scalar) -> Bool {
    switch c.properties.generalCategory {
    case .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
  }

  /** JavaScript's \s */
  static func space(_ c: Unicode.Scalar) -> Bool {
    c.properties.isWhitespace || c == "\u{FEFF}"
  }

  /** The pre-tokenizer: contractions, runs of letters, single digits, runs of other symbols; spaces dropped. */
  public static func words(_ text: String) -> [String] {
    let collapsed = String(String.UnicodeScalarView(text.precomposedStringWithCanonicalMapping.unicodeScalars.map { space($0) ? " " : $0 }))
    let s = collapsed.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ").lowercased()
    let chars = Array(s.unicodeScalars)
    var out: [String] = []
    var i = 0
    func str(_ a: Int, _ b: Int) -> String { String(String.UnicodeScalarView(chars[a..<b])) }
    while i < chars.count {
      let c = chars[i]
      if space(c) { i += 1; continue }
      if c == "'" {
        let rest = str(i + 1, min(chars.count, i + 3))
        if let m = ["s", "t", "re", "ve", "m", "ll", "d"].first(where: { rest.hasPrefix($0) }) {
          out.append("'" + m); i += 1 + m.unicodeScalars.count; continue
        }
      }
      if letter(c) {
        var j = i
        while j < chars.count && letter(chars[j]) { j += 1 }
        out.append(str(i, j)); i = j; continue
      }
      if digit(c) { out.append(String(c)); i += 1; continue }
      var j = i
      while j < chars.count && !space(chars[j]) && !letter(chars[j]) && !digit(chars[j]) { j += 1 }
      out.append(str(i, j)); i = j
    }
    return out
  }

  private func bpe(_ word: String) -> [Int] {
    if let hit = lock.withLock({ cache[word] }) { return hit }
    let chars = word.unicodeScalars.map { String($0) }
    guard !chars.isEmpty else { return [] }
    var parts = Array(chars.dropLast()) + [chars.last! + "</w>"]
    while parts.count > 1 {
      var best = Int.max, at = -1
      for i in 0..<(parts.count - 1) {
        if let r = ranks[parts[i] + " " + parts[i + 1]], r < best { best = r; at = i }
      }
      if at < 0 { break }
      let a = parts[at], b = parts[at + 1]
      var next: [String] = []
      var i = 0
      while i < parts.count {
        if i < parts.count - 1 && parts[i] == a && parts[i + 1] == b { next.append(a + b); i += 2 } else { next.append(parts[i]); i += 1 }
      }
      parts = next
    }
    let ids = parts.compactMap { vocab[$0] }
    lock.withLock { cache[word] = ids }
    return ids
  }

  public func encode(_ text: String) -> [Int] {
    var ids = [Self.start]
    for w in Self.words(text) {
      ids += bpe(Array(w.utf8).map { bytes[Int($0)] }.joined())
    }
    return Array(ids.prefix(Self.maxLen - 1)) + [Self.end]
  }
}
