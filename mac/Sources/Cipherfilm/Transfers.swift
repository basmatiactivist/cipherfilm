// The status card's lines for what goes up: the upload queue, WebDAV imports and watched folders, each with how much
// is done of how much, and how fast. While one runs they refresh every second; the speed is the bytes over the last
// few seconds.
import SwiftUI

/** Bytes a second from a running total, sampled over the last few seconds. */
@MainActor final class SpeedSampler {
  private var samples: [(at: Date, total: Int64)] = []

  func rate(_ total: Int64, now: Date = Date(), window: TimeInterval = 5) -> Double {
    if let last = samples.last, total < last.total { samples = [] } // a new pass started over
    if samples.last.map({ now.timeIntervalSince($0.at) >= 0.5 }) ?? true { samples.append((now, total)) }
    // keep one sample at or before the window's start, so the rate spans the whole window
    while samples.count > 2, now.timeIntervalSince(samples[1].at) >= window { samples.removeFirst() }
    guard let first = samples.first else { return 0 }
    let dt = now.timeIntervalSince(first.at)
    return dt >= 1 ? max(0, Double(total - first.total) / dt) : 0
  }
}

/** "1.2 GB of 4 GB · 8.4 MB/s" */
func amount(_ done: Int64, of total: Int64, speed: Double) -> String {
  "\(bytes(min(done, total))) of \(bytes(total))" + (speed >= 1 ? " · \(bytes(Int64(speed)))/s" : "")
}

struct TransferLines: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openSettings) private var openSettings
  @Binding var showUploads: Bool
  let failed: Int
  @State private var uploadSpeed = SpeedSampler()
  @State private var watchSpeed = SpeedSampler()

  var body: some View {
    let moving = model.uploadProgress != nil || model.webdav.running || model.watcher.running
    if moving {
      TimelineView(.periodic(from: .now, by: 1)) { _ in lines }
    } else {
      lines
    }
  }

  @ViewBuilder private var lines: some View {
    if let u = model.uploadProgress {
      let b = model.uploadBytes
      let head = model.uploadsPaused ? "Paused · " : "Uploading "
      let text = head + "\(min(u.done + 1, u.total)) of \(u.total)\n" + amount(b.done, of: b.total, speed: model.uploadsPaused ? 0 : uploadSpeed.rate(b.done))
      Button { showUploads = true } label: {
        StatusLine(icon: model.uploadsPaused ? "pause.circle" : "arrow.up.circle", text: text + (failed > 0 ? " · \(failed) failed" : ""), fraction: u.fraction)
      }.buttonStyle(TileButton(radius: 6)).help("Show uploads")
    }
    ForEach(model.settings.webdav.filter { [.listing, .importing].contains(model.webdav.status[$0.id]?.phase) }, id: \.id) { s in
      let st = model.webdav.status[s.id] ?? .init()
      Button { model.settingsTab = "import"; NSApp.activate(); openSettings() } label: {
        if st.phase == .listing {
          StatusLine(icon: "network", text: "Reading \(s.label)…")
        } else {
          let files = st.plan?.todo.count ?? 0
          StatusLine(icon: "network", text: "Importing from \(s.label)\n\(st.uploaded) of \(files) · " + amount(st.bytesDone, of: st.bytesTotal, speed: st.speed),
                     fraction: st.bytesTotal > 0 ? Double(st.bytesDone) / Double(st.bytesTotal) : nil)
        }
      }.buttonStyle(TileButton(radius: 6)).help("Show WebDAV imports")
    }
    if model.settings.watchOn {
      let w = model.watcher
      let folders = model.settings.watched.count
      if let p = w.problem {
        StatusLine(icon: "eye", text: p, problem: true)
      } else if w.running, let name = w.current {
        let more = w.waiting > 1 ? " · \(w.waiting - 1) more" : ""
        StatusLine(icon: "eye", text: "Uploading \(name)\(more)\n" + amount(w.bytesDone, of: w.bytesTotal, speed: watchSpeed.rate(w.bytesDone)),
                   fraction: w.bytesTotal > 0 ? Double(w.bytesDone) / Double(w.bytesTotal) : nil)
      } else if w.running {
        StatusLine(icon: "eye", text: "Checking watched folders")
      } else {
        StatusLine(icon: "eye", text: "Watching \(folders) folder\(folders == 1 ? "" : "s") · \(w.uploaded) uploaded")
      }
    }
  }
}
