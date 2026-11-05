// Decrypted thumbnails and previews, in memory only (NSCache, emptied at every lock). Thumbnails come in batches of up
// to 100 per request, are decoded off the main thread, and the newest 400 are fetched ahead when the library opens.
import AppKit
import ImageIO
import CipherfilmCore

final class ImageStore: @unchecked Sendable {
  private let thumbs = NSCache<NSString, NSImage>()
  private let previews = NSCache<NSString, NSImage>()
  private let faces = NSCache<NSString, NSImage>()
  private let gate = Gate(12)

  init() {
    thumbs.countLimit = 3000
    previews.countLimit = 16
    faces.countLimit = 400
  }

  func clear() {
    thumbs.removeAllObjects(); previews.removeAllObjects(); faces.removeAllObjects()
  }

  func cachedThumb(_ id: String) -> NSImage? { thumbs.object(forKey: id as NSString) }

  private let batcher = ThumbBatcher()

  /** A thumbnail, decoded off the main thread; asked for together with the other tiles on screen in one request. */
  func thumb(_ it: Item, _ vault: Vault) async -> NSImage? {
    if let hit = thumbs.object(forKey: it.id as NSString) { return hit }
    guard it.hasThumb, !it.broken else { return nil }
    guard let d = await batcher.get(it, vault), let img = await Task.detached(priority: .userInitiated, operation: { Self.decode(d) }).value else { return nil }
    guard vault.isOpen else { return nil }
    thumbs.setObject(img, forKey: it.id as NSString)
    return img
  }

  /** Thumbnails of the items the grid will show next, fetched ahead in the background. */
  func prefetch(_ items: [Item], _ vault: Vault) {
    let want = items.filter { $0.hasThumb && !$0.broken && thumbs.object(forKey: $0.id as NSString) == nil }
    guard !want.isEmpty else { return }
    Task.detached(priority: .utility) {
      for chunk in want.chunked(100) {
        guard vault.isOpen, let got = try? await vault.thumbnails(chunk) else { return }
        for (id, d) in got { if let img = Self.decode(d) { self.thumbs.setObject(img, forKey: id as NSString) } }
      }
    }
  }

  /** JPEG bytes to a ready-to-draw image (decoded now, not when the grid first draws it), never larger than
   *  Media.decodeBounded allows. */
  nonisolated static func decode(_ d: Data) -> NSImage? {
    guard let cg = Media.decodeBounded(d) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
  }

  func preview(_ it: Item, _ vault: Vault) async -> NSImage? {
    if let hit = previews.object(forKey: it.id as NSString) { return hit }
    guard it.hasPreview || it.hasThumb, !it.broken else { return nil }
    guard let d = try? await vault.picture(it.hasPreview ? .preview : .thumb, of: it),
          let img = await Task.detached(priority: .userInitiated, operation: { Self.decode(d) }).value else { return nil }
    guard vault.isOpen else { return nil }
    previews.setObject(img, forKey: it.id as NSString)
    return img
  }

  /** The original photo, decoded (HEIC, RAW and everything macOS reads), for the viewer at full size. */
  func original(_ it: Item, _ vault: Vault) async -> NSImage? {
    guard it.kind == .image, !it.broken, (0..<120 << 20).contains(it.size) else { return nil }
    var data = Data()
    for i in 0..<Segments.count(it.size) {
      guard let s = try? await vault.segment(i, of: it) else { return nil }
      data.append(s)
    }
    guard vault.isOpen else { return nil }
    return NSImage(data: data)
  }

  /** A round-ready square crop of a face from the item's thumbnail. */
  func face(_ cover: FaceGroup.Cover, item: Item, _ vault: Vault) async -> NSImage? {
    if let hit = faces.object(forKey: cover.key as NSString) { return hit }
    guard let d = try? await gate.run({ try await vault.bestPicture(of: item) }), let cg = Vision.faceCrop(d, box: cover.box, px: 192) else { return nil }
    let img = NSImage(cgImage: cg, size: NSSize(width: 96, height: 96))
    guard vault.isOpen else { return nil }
    faces.setObject(img, forKey: cover.key as NSString)
    return img
  }
}

/** Collects the thumbnails asked for within a few milliseconds and fetches them in one request; falls back to one
 *  request each against a server without the batch endpoint. */
actor ThumbBatcher {
  private var waiting: [(Item, CheckedContinuation<Data?, Never>)] = []
  private var vault: Vault?
  private var scheduled = false
  private var single = false
  private let gate = Gate(16)

  func get(_ it: Item, _ v: Vault) async -> Data? {
    if single { return try? await gate.run { try await v.picture(.thumb, of: it) } }
    return await withCheckedContinuation { c in
      waiting.append((it, c))
      vault = v
      if !scheduled {
        scheduled = true
        Task { try? await Task.sleep(nanoseconds: 15_000_000); await self.flush() }
      }
    }
  }

  private func flush() async {
    scheduled = false
    let batch = waiting
    waiting = []
    guard let v = vault, !batch.isEmpty else { batch.forEach { $0.1.resume(returning: nil) }; return }
    // newest request first: what is on screen now
    for chunk in Array(batch.reversed()).chunked(100) {
      do {
        let got = try await v.thumbnails(chunk.map(\.0))
        for (it, c) in chunk { c.resume(returning: got[it.id]) }
      } catch let e as APIError where e.status == 404 || e.status == 405 {
        single = true
        for (it, c) in chunk { c.resume(returning: try? await gate.run { try await v.picture(.thumb, of: it) }) }
      } catch {
        for (_, c) in chunk { c.resume(returning: nil) }
      }
    }
  }
}

extension Array {
  func chunked(_ n: Int) -> [[Element]] { stride(from: 0, to: count, by: n).map { Array(self[$0..<Swift.min($0 + n, count)]) } }
}

/** At most n tasks at a time. */
actor Gate {
  private let max: Int
  private var active = 0
  private var waiting: [CheckedContinuation<Void, Never>] = []
  init(_ max: Int) { self.max = max }

  func run<T: Sendable>(_ f: @Sendable () async throws -> T) async throws -> T {
    if active >= max { await withCheckedContinuation { waiting.append($0) } }
    active += 1
    defer {
      active -= 1
      if !waiting.isEmpty { waiting.removeLast().resume() } // newest request first: what is on screen now
    }
    return try await f()
  }
}
