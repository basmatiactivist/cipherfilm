// Photos turned and cropped in the web or Android app (docs/EDITING.md): the Mac reads the edit from the encrypted
// metadata as those apps write it (web/src/edit/edit.ts), never fails on a bad one, and draws the original so.
import CoreGraphics
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct PictureEditTests {
  private func meta(_ edit: String) throws -> ItemMeta {
    let json = #"{"name":"a.jpg","mime":"image/jpeg","size":10,"lastModified":1,"capture_ts":2,"#
      + #""orig":{"capture_ts":1,"gps":null},"edit":"# + edit + "}"
    return try JSONDecoder().decode(ItemMeta.self, from: Data(json.utf8))
  }

  @Test func readsWhatTheOtherAppsWrite() throws {
    let m = try meta(#"{"rot":90,"crop":{"x":0.1,"y":0.2,"w":0.5,"h":0.6},"v":"ab12"}"#)
    #expect(m.edit == PictureEdit(rot: 90, crop: CropRect(x: 0.1, y: 0.2, w: 0.5, h: 0.6), v: "ab12"))
    #expect(m.capture_ts == 2)
  }

  @Test func aBadEditIsNoEditNotABrokenItem() throws {
    for bad in [#""rotate""#, "[90]", #"{"rot":45}"#, #"{"rot":"x","crop":"y"}"#, #"{"crop":{"x":0,"y":0,"w":1,"h":1}}"#, "null"] {
      let m = try meta(bad)
      #expect(m.edit == nil || m.edit!.isIdentity, "\(bad)")
    }
    #expect(try meta(#"{"rot":-90,"v":"../x"}"#).edit == PictureEdit(rot: 270))
  }

  @Test func turnsRectanglesLikeTheWebApp() {
    let r = CropRect(x: 0.1, y: 0.2, w: 0.3, h: 0.4)
    #expect(PictureEdit.rotate(r, by: 90) == CropRect(x: 0.4, y: 0.1, w: 0.4, h: 0.3))
    #expect(PictureEdit.rotate(r, by: 180) == CropRect(x: 0.6, y: 0.4, w: 0.3, h: 0.4))
    // the left half of a picture turned clockwise is the bottom half of the original
    #expect(PictureEdit(rot: 90, crop: CropRect(x: 0, y: 0, w: 0.5, h: 1)).sourceRect == CropRect(x: 0, y: 0.5, w: 1, h: 0.5))
  }

  @Test func plansTheDrawingLikeTheWebApp() {
    // the same numbers as edit.test.ts "plans the drawing in pixels"
    let p = PictureEdit(rot: 90, crop: CropRect(x: 0, y: 0, w: 0.5, h: 1)).plan(width: 4000, height: 3000, maxPx: 1000)
    #expect(p.sx == 0 && p.sy == 1500 && p.sw == 4000 && p.sh == 1500 && p.rot == 90)
    #expect(max(p.outW, p.outH) == 1000 && p.outW == p.dh && p.outH == p.dw)
  }

  /** A 4×2 picture, left half red, right half blue. */
  private func picture() -> CGImage {
    let ctx = CGContext(data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
    ctx.setFillColor(red: 0, green: 0, blue: 1, alpha: 1); ctx.fill(CGRect(x: 2, y: 0, width: 2, height: 2))
    return ctx.makeImage()!
  }

  /** red or blue at (x, y) from the top left */
  private func color(_ img: CGImage, _ x: Int, _ y: Int) -> String {
    let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
    let px = ctx.data!.assumingMemoryBound(to: UInt8.self)
    let o = (y * img.width + x) * 4 // the bitmap's first row is the picture's top
    return px[o] > 128 ? "red" : px[o + 2] > 128 ? "blue" : "other"
  }

  @Test func drawsTheOriginalTurnedAndCropped() throws {
    // turned clockwise: 2×4, red (the left) on top
    let turned = try #require(PictureEdit(rot: 90).apply(to: picture()))
    #expect(turned.width == 2 && turned.height == 4)
    #expect(color(turned, 0, 0) == "red" && color(turned, 1, 3) == "blue")
    // turned the other way, blue on top
    let back = try #require(PictureEdit(rot: 270).apply(to: picture()))
    #expect(color(back, 0, 0) == "blue" && color(back, 0, 3) == "red")
    // cropped to the right half: only blue
    let right = try #require(PictureEdit(crop: CropRect(x: 0.5, y: 0, w: 0.5, h: 1)).apply(to: picture()))
    #expect(right.width == 2 && right.height == 2 && color(right, 0, 0) == "blue")
  }

  @Test func picturesAreCachedByVersion() {
    var it = Item(id: "ab", kind: .image, size: 10, segmentCount: 1, createdAt: 1, hasThumb: true, hasPreview: true, favorite: false,
                  trashedAt: nil, purgeAt: nil, meta: ItemMeta(name: "a.jpg", mime: "image/jpeg", size: 10, lastModified: 1, capture_ts: 1), itemKey: nil, broken: false)
    #expect(it.pictureKey == "ab" && !it.isEditedPicture)
    it.meta!.edit = PictureEdit(rot: 90, v: "v1")
    #expect(it.pictureKey == "ab.v1" && it.isEditedPicture)
    // laid out as shown: a 4000×3000 photo turned and 80 % of its width kept is 2400×4000
    it.meta!.width = 4000; it.meta!.height = 3000
    it.meta!.edit = PictureEdit(rot: 90, crop: CropRect(x: 0, y: 0, w: 0.8, h: 1), v: "v2")
    #expect(abs(it.aspect - 2400.0 / 4000) < 1e-9)
  }
}
