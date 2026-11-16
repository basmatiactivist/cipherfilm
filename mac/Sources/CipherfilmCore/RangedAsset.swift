// A video elsewhere (a WebDAV folder) as an AVAsset that AVFoundation reads through ranged requests: its duration,
// size, date, place and a frame for the thumbnail come from the few parts it asks for (moov, wherever it is, and the
// samples of one frame), never the whole file. A budget caps what it may fetch; past it the frame or the metadata is
// left out (the video still uploads, like a local one macOS can't decode).
import AVFoundation
import Foundation
import UniformTypeIdentifiers

public final class RangedAsset: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
  public let size: Int64
  private let uti: String
  private let read: @Sendable (Int64, Int) async throws -> Data
  private let budget: Int64
  private let lock = NSLock()
  private var spent: Int64 = 0
  private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
  private let queue = DispatchQueue(label: "app.cipherfilm.ranged-asset")
  public let asset: AVURLAsset

  /** name: for its type (the extension). budget: the most bytes AVFoundation may read. */
  public init(name: String, size: Int64, budget: Int64 = 64 << 20, read: @escaping @Sendable (Int64, Int) async throws -> Data) {
    let ext = (name as NSString).pathExtension.lowercased()
    self.size = size
    self.uti = UTType(filenameExtension: ext)?.identifier ?? UTType.mpeg4Movie.identifier
    self.read = read
    self.budget = budget
    // a scheme of its own, so AVFoundation asks this delegate for every byte
    self.asset = AVURLAsset(url: URL(string: "cfranged://media/file.\(ext.isEmpty ? "mp4" : ext)")!)
    super.init()
    asset.resourceLoader.setDelegate(self, queue: queue)
  }

  /** Bytes AVFoundation had fetched so far. */
  public var fetched: Int64 { lock.withLock { spent } }

  public func cancel() {
    let all = lock.withLock { let t = tasks; tasks = [:]; return t }
    all.values.forEach { $0.cancel() }
    asset.cancelLoading()
  }

  private func charge(_ n: Int) -> Bool {
    lock.withLock {
      guard spent + Int64(n) <= budget else { return false }
      spent += Int64(n); return true
    }
  }

  public func resourceLoader(_ loader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource req: AVAssetResourceLoadingRequest) -> Bool {
    if let info = req.contentInformationRequest {
      info.contentType = uti
      info.contentLength = size
      info.isByteRangeAccessSupported = true
    }
    guard let dr = req.dataRequest else { req.finishLoading(); return true }
    let start = dr.currentOffset > dr.requestedOffset ? dr.currentOffset : dr.requestedOffset
    let end = dr.requestsAllDataToEndOfResource ? size : min(size, dr.requestedOffset + Int64(dr.requestedLength))
    let box = Unchecked(req)
    let key = ObjectIdentifier(req)
    let read = self.read
    let t = Task { [weak self] in
      var o = start
      do {
        while o < end {
          try Task.checkCancellation()
          let n = Int(min(1 << 20, end - o))
          guard self?.charge(n) == true else {
            // over budget: AVFoundation stops waiting for more instead of retrying for a while
            self?.asset.cancelLoading()
            throw WebDAVError.status(-1)
          }
          let d = try await read(o, n)
          guard !d.isEmpty else { throw WebDAVError.changed }
          box.v.dataRequest?.respond(with: d)
          o += Int64(d.count)
        }
        box.v.finishLoading()
      } catch {
        if !box.v.isCancelled && !box.v.isFinished { box.v.finishLoading(with: error) }
      }
      self?.lock.withLock { _ = self?.tasks.removeValue(forKey: key) }
    }
    lock.withLock { tasks[key] = t }
    return true
  }

  public func resourceLoader(_ loader: AVAssetResourceLoader, didCancel req: AVAssetResourceLoadingRequest) {
    let t = lock.withLock { tasks.removeValue(forKey: ObjectIdentifier(req)) }
    t?.cancel()
  }
}

/** A value handed between threads that is only used by one at a time. */
struct Unchecked<T>: @unchecked Sendable {
  let v: T
  init(_ v: T) { self.v = v }
}
