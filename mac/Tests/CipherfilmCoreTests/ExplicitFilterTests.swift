// One model for everyone and the explicit-content filter of search (docs/SEARCH.md, "One model", "Explicit content"):
// the concepts are the same numbers as server/explicit-filter.json (which the web and Android apps read), the score
// works as in web/src/search/explicit.ts, filtered search leaves explicit photos out, and entries made with MobileCLIP
// before give their faces to the new ones.
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private struct Filter: Decodable {
  struct T: Decodable { let threshold: Float }
  struct C: Decodable { let text: String; let explicit: Bool; let image: Bool; let vec: String }
  let model: String; let image: T; let query: T; let concepts: [C]
}
private let filter = try! JSONDecoder().decode(Filter.self, from: Data(contentsOf: repo.appendingPathComponent("server/explicit-filter.json")))
private func vec(_ text: String) -> [Float] { Vision.normalize(Vision.unhalf(try! B64.decode(filter.concepts.first { $0.text == text }!.vec))) }

@Suite struct ExplicitFilterTests {
  @Test func sameConceptsAsTheOtherApps() {
    #expect(filter.model == ClipModel.clip.text.sha256)
    #expect(Explicit.imageThreshold == filter.image.threshold && Explicit.queryThreshold == filter.query.threshold)
    #expect(ExplicitConcepts.all.count == filter.concepts.count)
    for (a, b) in zip(ExplicitConcepts.all, filter.concepts) { #expect(a.explicit == b.explicit && a.image == b.image && a.vec == b.vec, "\(b.text)") }
    #expect(Explicit.concepts.count == filter.concepts.count && Explicit.concepts.allSatisfy { $0.v.count == Vision.clipDim })
  }

  @Test func scoresAndThresholds() {
    #expect(Explicit.imageHidden(vec("a photo of a naked person")) && Explicit.imageHidden(vec("pornography")))
    for t in ["a photo of a person", "a photo of people at the beach", "a landscape photo", "a screenshot", "a photo of a baby"] { #expect(!Explicit.imageHidden(vec(t)), "\(t)") }
    for t in ["nude", "porn", "nackt"] { #expect(Explicit.queryBlocked(vec(t)), "\(t)") }
    for t in ["beach", "dog", "swimsuit", "bikini", "baby", "bath", "statue"] { #expect(!Explicit.queryBlocked(vec(t)), "\(t)") }
    // the same number as the web's explicitScore (scale doesn't matter; another length is never hidden)
    let v = vec("a photo of a naked person")
    #expect(abs(Explicit.score(v.map { $0 * 3 }, image: true) - Explicit.score(v, image: true)) < 1e-5)
    #expect(Explicit.score([Float](repeating: 0.1, count: 256), image: true).isNaN && !Explicit.imageHidden([Float](repeating: 0.1, count: 256)))
  }

  @Test func unfilteredOnlyWhereAllowedAndChosen() {
    #expect(Explicit.unfiltered(allowed: true, chosen: true))
    #expect(!Explicit.unfiltered(allowed: false, chosen: true)) // the admin withdrew it
    #expect(!Explicit.unfiltered(allowed: true, chosen: false))
  }

  @Test func filteredSearchLeavesExplicitPhotosOut() {
    let idx = SearchIndex()
    idx.put("beach", clip: Vision.half(vec("a photo of people at the beach")), faces: [])
    idx.put("x", clip: Vision.half(vec("a photo of a naked person")), faces: [])
    idx.put("dog", clip: Vision.half(vec("a photo of an animal")), faces: [])
    #expect(idx.hidden("x") && !idx.hidden("beach") && !idx.hidden("dog"))
    let q = vec("beach")
    #expect(Set(idx.search(q, limit: 10, minScore: -2).map(\.id)) == ["beach", "x", "dog"])
    #expect(Set(idx.search(q, limit: 10, minScore: -2, filtered: true).map(\.id)) == ["beach", "dog"])
    // a row moved into a removed one's place keeps its own score
    idx.remove("beach")
    #expect(idx.hidden("x") && !idx.hidden("dog"))
    #expect(idx.search(q, limit: 10, minScore: -2, filtered: true).map(\.id) == ["dog"])
    // similar photos (a cleanup and browsing tool) aren't filtered
    #expect(idx.similar("dog", limit: 10, minScore: -2).map(\.id) == ["x"])
  }

  @Test func oneModelAndMobileCLIPsEntriesFromBefore() throws {
    #expect(Models.every.map(\.name) == ["clip-b32-vision.onnx", "clip-b32-text.onnx", "clip-b32-tokenizer.json", "yunet-2023mar.onnx", "sface-2021dec.onnx"])
    // explicit search's LAION entries are the model's: kept, not made again
    #expect(Models.good("laionb32+yunet23+sface21/1", faces: true) && Models.good("laionb32/1", faces: false))
    #expect(!Models.good("mcs2+yunet23+sface21/2", faces: true) && !Models.good("mcs2/2", faces: false))
    #expect(ClipModel.legacyFaces("mcs2+yunet23+sface21/2") && !ClipModel.legacyFaces("mcs2/2") && !ClipModel.legacyFaces(nil))
    // a new entry takes the faces of the MobileCLIP entry (the people document names them "<item>:<n>")
    let known = [IndexEntry.Face(box: [0.5, 0.5, 0.1, 0.1], score: 0.9, emb: "AAAA")]
    let one = IndexEntry.entries(Analyses(clips: [(.clip, Data([3, 0]))], faces: nil), faces: true, known: known)
    #expect(one.count == 1 && one[0].m == ClipModel.clip.tag && one[0].faces?.map(\.emb) == ["AAAA"])
    let kp = Sodium.boxKeypair()
    let id = "0123456789abcdef0123456789abcdef"
    let back = try IndexEntry.open(try one[0].seal(pk: kp.pk, itemId: id), pair: KeyPair(pk: kp.pk, sk: kp.sk), itemId: id)
    #expect(back.m == ClipModel.clip.tag && back.faces?.count == 1)
  }
}
