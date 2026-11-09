// An item id from the server becomes a path (the share and drag copies) only after it passed the 32-hex check, and
// only items that decrypted can be written out.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct ItemIdTests {
  private func item(_ id: String, broken: Bool = false, key: Bool = true) -> Item {
    Item(id: id, kind: .image, size: 1, segmentCount: 1, createdAt: 0, hasThumb: false, hasPreview: false, favorite: false,
         trashedAt: nil, purgeAt: nil, meta: broken ? nil : ItemMeta(name: "a.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0),
         itemKey: key ? Data(repeating: 1, count: 32) : nil, broken: broken)
  }

  @Test func folderOnlyForValidIds() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cf-out-test-\(UUID().uuidString)", isDirectory: true)
    let good = String(repeating: "0a", count: 16)
    #expect(ServerId.folder(in: dir, good)?.path == dir.appendingPathComponent(good).path)
    for bad in ["../../x", "../" + good, good + "/..", "/etc", "..", "", String(repeating: "A", count: 32), good.dropLast() + "/", good + "0"] {
      #expect(ServerId.folder(in: dir, String(bad)) == nil, "\(bad)")
    }
    #expect(!FileManager.default.fileExists(atPath: dir.path))
  }

  @Test func onlyDecryptedItemsWithValidIdsOpen() {
    let good = String(repeating: "0a", count: 16)
    #expect(item(good).openable)
    #expect(!item(good, broken: true).openable)
    #expect(!item(good, key: false).openable)
    #expect(!item("../../" + good).openable)
  }
}
