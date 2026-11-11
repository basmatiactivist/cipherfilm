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
}
