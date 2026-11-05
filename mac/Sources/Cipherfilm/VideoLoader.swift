// Video playback without a decrypted file: AVPlayer asks for byte ranges of a made-up URL, and this loader answers
// from the item's 4 MiB segments, decrypted in memory (the last few are kept for seeking back and forth).
import AVFoundation
import CipherfilmCore
import UniformTypeIdentifiers

final class VideoLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
  let item: Item
  let vault: Vault
  private let queue = DispatchQueue(label: "cf.video")
  private var cache: [Int: Data] = [:]
  private var order: [Int] = []
  private var inflight: [Int: Task<Data, Error>] = [:]
  private let lock = NSLock()

  init(item: Item, vault: Vault) { self.item = item; self.vault = vault }

  func asset() -> AVURLAsset {
    let ext = (item.name as NSString).pathExtension.isEmpty ? "mp4" : (item.name as NSString).pathExtension
    let a = AVURLAsset(url: URL(string: "cfvideo://item/\(item.id).\(ext)")!)
    a.resourceLoader.setDelegate(self, queue: queue)
    return a
  }

  private func segment(_ i: Int) async throws -> Data {
    let t: Task<Data, Error> = lock.withLock {
      if let d = cache[i] { return Task { d } }
      if let t = inflight[i] { return t }
      let t = Task { try await self.vault.segment(i, of: self.item) }
      inflight[i] = t
      return t
    }
    let d = try await t.value
    lock.withLock {
      inflight[i] = nil
      if cache[i] == nil {
        cache[i] = d; order.append(i)
        while order.count > 4 { cache.removeValue(forKey: order.removeFirst()) }
      }
    }
    return d
  }

  func resourceLoader(_ loader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource r: AVAssetResourceLoadingRequest) -> Bool {
    if let info = r.contentInformationRequest {
      let mime = item.meta?.mime ?? "video/mp4"
      info.contentType = UTType(mimeType: mime)?.identifier ?? UTType.mpeg4Movie.identifier
      info.contentLength = item.size
      info.isByteRangeAccessSupported = true
    }
    guard let dr = r.dataRequest else { r.finishLoading(); return true }
    let start = dr.currentOffset != 0 ? dr.currentOffset : dr.requestedOffset
    let end = dr.requestsAllDataToEndOfResource ? item.size : min(item.size, dr.requestedOffset + Int64(dr.requestedLength))
    let req = UncheckedRequest(r)
    Task {
      var off = start
      do {
        while off < end {
          if req.r.isCancelled { return }
          let i = Int(off / Int64(Segments.plain))
          let seg = try await segment(i)
          let from = Int(off - Int64(i) * Int64(Segments.plain))
          let to = min(seg.count, from + Int(end - off))
          guard from < to else { break }
          req.r.dataRequest?.respond(with: seg.subdata(in: from..<to))
          off += Int64(to - from)
        }
        req.r.finishLoading()
      } catch {
        req.r.finishLoading(with: error)
      }
    }
    return true
  }

  func close() { lock.withLock { cache = [:]; order = []; inflight.values.forEach { $0.cancel() }; inflight = [:] } }
}

struct UncheckedRequest: @unchecked Sendable {
  let r: AVAssetResourceLoadingRequest
  init(_ r: AVAssetResourceLoadingRequest) { self.r = r }
}
