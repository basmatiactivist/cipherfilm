// The metadata the Mac's uploader writes: the original's SHA-256 goes in as 64 lowercase hex characters, the form the
// web and Android apps write and the duplicates screen compares (docs/CRYPTO.md).
import CryptoKit
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct UploadMetaTests {
  @Test func sha256IsLowercaseHexOfTheOriginal() throws {
    var h = SHA256()
    h.update(data: Data("ab".utf8)); h.update(data: Data("c".utf8)) // fed part by part, like the upload's parts
    let hex = Uploader.hex(h.finalize())
    #expect(hex == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    let json = try Uploader.metaJSON(name: "a.jpg", mime: "image/jpeg", size: 3, modified: Date(timeIntervalSince1970: 1), info: Media.Info(), dims: (4, 3), sha256: hex)
    let m = try JSONSerialization.jsonObject(with: json) as! [String: Any]
    #expect(m["sha256"] as? String == hex)
    #expect(m["width"] as? Int == 4)
    #expect(m["capture_ts"] as? Double == 1000)
  }

  /** A place that isn't one, or a number JSON can't hold, is left out rather than ending the app. */
  @Test func oddNumbersAreLeftOut() throws {
    for (la, lo) in [(Double.nan, 8.5), (47.3, Double.infinity), (1e300, 8.5), (47.3, -181), (0, 0)] {
      var i = Media.Info()
      i.lat = la; i.lon = lo; i.duration = .nan; i.captureTs = .infinity
      let json = try Uploader.metaJSON(name: "a.jpg", mime: "image/jpeg", size: 3, modified: Date(timeIntervalSince1970: 2), info: i, dims: nil, sha256: nil)
      let m = try JSONSerialization.jsonObject(with: json) as! [String: Any]
      #expect(m["gps"] == nil && m["duration"] == nil)
      #expect(m["capture_ts"] as? Double == 2000)
    }
    var ok = Media.Info()
    ok.lat = -33.9; ok.lon = 151.2
    let m = try JSONSerialization.jsonObject(with: Uploader.metaJSON(name: "a.jpg", mime: "image/jpeg", size: 3, modified: Date(), info: ok, dims: nil, sha256: nil)) as! [String: Any]
    #expect((m["gps"] as? [String: Double])?["lat"] == -33.9)
    #expect(Media.validPlace(47.3, 8.5) && !Media.validPlace(.nan, 0) && !Media.validPlace(91, 0))
  }

  @Test func withoutAHashTheFieldIsLeftOut() throws {
    let json = try Uploader.metaJSON(name: "a.jpg", mime: "image/jpeg", size: 3, modified: Date(), info: Media.Info(), dims: nil, sha256: nil)
    let m = try JSONSerialization.jsonObject(with: json) as! [String: Any]
    #expect(m["sha256"] == nil)
  }

  @Test func olderAppsReadTheMetadataWithTheNewField() throws {
    let json = Data(#"{"name":"a.jpg","mime":"image/jpeg","size":3,"lastModified":1,"capture_ts":1,"sha256":"00"}"#.utf8)
    let m = try JSONDecoder().decode(ItemMeta.self, from: json)
    #expect(m.name == "a.jpg")
  }

  /** The metadata's version (`mv`, raised by the web and Android apps at every change) is read past without trouble:
   *  the Mac only uploads metadata, never changes it, so it neither needs nor drops it. */
  @Test func theMetadataVersionIsIgnored() throws {
    for mv in ["7", "0", "-1", "\"x\"", "1e300", "null"] {
      let json = Data(#"{"name":"a.jpg","mime":"image/jpeg","size":3,"lastModified":1,"capture_ts":1,"mv":"#.utf8 + Data(mv.utf8) + Data("}".utf8))
      let m = try JSONDecoder().decode(ItemMeta.self, from: json)
      #expect(m.name == "a.jpg" && m.size == 3)
    }
  }
}
