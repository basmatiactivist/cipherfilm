// The list every view reads (AppModel.items) never holds an item of the locked folder: it is split off where the
// decrypted list is published, and kept only while the folder is open.
import Foundation
import Testing
@testable import Cipherfilm
@testable import CipherfilmCore

@MainActor @Suite(.serialized) struct LockedFolderTests {
  private func item(_ n: Int, _ extra: String) throws -> Item {
    let m = try JSONDecoder().decode(ItemMeta.self, from: Data(#"{"name":"\#(n).jpg","mime":"image/jpeg","size":1,"lastModified":0,"capture_ts":\#(n)\#(extra)}"#.utf8))
    return Item(id: String(format: "%032x", n), kind: .image, size: 1, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true,
                favorite: n == 2, trashedAt: nil, purgeAt: nil, meta: m, itemKey: Data(repeating: 7, count: 32), broken: false)
  }

  @Test func thePublishedListNeverHoldsALockedItem() throws {
    let m = AppModel.shared
    let list = [try item(1, ""), try item(2, #","locked":true"#), try item(3, #","archived":true"#), try item(4, #","locked":"true""#)]
    m.setItems(list)
    defer { m.setItems([]) }
    let locked = list[1].id
    #expect(!m.items.contains { $0.isLocked })
    #expect(Set(m.items.map(\.id)) == Set([list[0].id, list[2].id, list[3].id]))
    #expect(m.item(locked) == nil && m.anyItem(locked) == nil)
    #expect(m.lockedItems.isEmpty && !m.lockedOpen) // not kept while the folder is closed
    // the main grid and On this day: not the archived one either; the archive shows it
    #expect(Set(m.mainItems.map(\.id)) == Set([list[0].id, list[3].id]))
    #expect(m.archivedItems.map(\.id) == [list[2].id])
    // the favorite is locked: favorites (read from items) don't show it
    #expect(!m.items.filter(\.favorite).contains { $0.id == locked })
    m.leaveLocked()
    #expect(m.lockedItems.isEmpty && m.anyItem(locked) == nil)
  }

  /** A check that finishes after the folder was left opens nothing: the next visit asks again. */
  @Test func aCheckFromAnEarlierVisitOpensNothing() async {
    let m = AppModel.shared
    let visit = m.lockedVisit
    m.leaveLocked() // another screen or a search while the check runs
    #expect(m.lockedVisit != visit)
    await m.openLocked(visit: visit)
    #expect(!m.lockedOpen && m.lockedItems.isEmpty)
  }
}
