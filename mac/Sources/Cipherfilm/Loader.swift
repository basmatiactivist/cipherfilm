// The loading badge, the same as the web's (web/src/loader.tsx) and Android's (mobile/src/Loader.tsx): the mark
// ("Photo lock") on a round seal whose outer edge is the loading ring, a teal arc turning around it. The large one
// also seals the mark: tiles pass over the photo, then the shackle closes. With reduced motion the ring only fades.
// Drawn on the 48 grid in a Canvas, one frame per display refresh while it is on screen.
import SwiftUI

struct Loader: View {
  var large = false
  @Environment(\.accessibilityReduceMotion) private var reduced
  @Environment(\.colorScheme) private var scheme

  /** The mark on the 48 grid: half the badge tall on the large one, a little more on the small one. */
  private var mark: (x: CGFloat, y: CGFloat, k: CGFloat) { large ? (9.6, 9.84, 1.2) : (8.4, 8.66, 1.3) }

  var body: some View {
    let size = large ? Metric.loaderLarge : Metric.loader
    TimelineView(.animation) { tl in
      let t = tl.date.timeIntervalSinceReferenceDate
      Canvas { g, sz in draw(&g, u: sz.width / 48, t: t) }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  private func draw(_ g: inout GraphicsContext, u: CGFloat, t: TimeInterval) {
    let w: CGFloat = large ? 2.5 : 5 // thicker on the small badge, so it still reads at 16 pt
    let r = (24 - w / 2) * u
    let c = CGPoint(x: 24 * u, y: 24 * u)
    let seal = large && !reduced ? t.truncatingRemainder(dividingBy: Motion.seal) / Motion.seal : 0.7
    g.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: 48 * u, height: 48 * u)), with: .color(Ink.card))
    let ring = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    g.stroke(ring, with: .color(scheme == .dark ? Ink.ruleStrong : Ink.rule), lineWidth: w * u)

    // the shackle open, closing once the tiles have passed, then open again for the next loop (as on the web)
    let m = mark, k = m.k * u
    let lift = Self.ramp(seal, [(0, -1.7), (0.46, -1.7), (0.56, 0.25), (0.6, 0), (0.86, 0), (1, -1.7)]) * k
    let p = PhotoLock.paths(scale: k, dx: m.x * u, dy: m.y * u)
    g.fill(Path(p.body), with: .color(Ink.teal), style: FillStyle(eoFill: true))
    g.fill(Path(p.shackle).offsetBy(dx: 0, dy: lift), with: .color(Ink.teal))
    if large && !reduced {
      // tiles over the photo body glint in the badge's own color, later the further they are from the top left
      for i in 0..<12 {
        let col = i % 4, row = i / 4
        let d = Double(col + row) * 0.1 / Motion.seal
        let o = Self.ramp(seal - d, [(0, 0), (0.08, 0.5), (0.26, 0), (1, 0)])
        guard o > 0.001 else { continue }
        let rect = CGRect(x: m.x * u + (3.6 + CGFloat(col) * 4.2) * k, y: m.y * u + (9.4 + CGFloat(row) * 4.2) * k, width: 4.2 * k, height: 4.2 * k)
        g.fill(Path(rect), with: .color(Ink.card.opacity(o)))
      }
    }

    if reduced {
      // no turning: the whole ring fades in and out
      let phase = t.truncatingRemainder(dividingBy: 2 * Motion.breathe) / Motion.breathe
      let fade = 0.35 + 0.65 * (0.5 - 0.5 * cos(.pi * phase))
      g.stroke(ring, with: .color(Ink.teal.opacity(fade)), lineWidth: w * u)
    } else {
      let start = -90 + 360 * t.truncatingRemainder(dividingBy: Motion.turn) / Motion.turn
      var arc = Path()
      arc.addArc(center: c, radius: r, startAngle: .degrees(start), endAngle: .degrees(start + 0.26 * 360), clockwise: false)
      g.stroke(arc, with: .color(Ink.teal), style: StrokeStyle(lineWidth: w * u, lineCap: .round))
    }
  }

  /** Straight lines between keyframes (time 0...1, value), held before the first. */
  static func ramp(_ x: Double, _ keys: [(Double, Double)]) -> Double {
    guard x > keys[0].0 else { return keys[0].1 }
    for (a, b) in zip(keys, keys.dropFirst()) where x <= b.0 {
      return a.1 + (b.1 - a.1) * (x - a.0) / max(b.0 - a.0, 1e-9)
    }
    return keys[keys.count - 1].1
  }
}

/** Something is loading: the large badge with what is happening, centred where the content will be. `inline` is the
 *  small badge in a row; `stage` is for the black viewer. Fades in after a moment, so a quick load doesn't flash. */
struct Loading: View {
  var label = "Loading…"
  var inline = false
  var stage = false
  @State private var shown = false
  @Environment(\.accessibilityReduceMotion) private var reduced

  var body: some View {
    Group {
      if inline {
        HStack(spacing: 10) { Loader(); Text(label).font(Typo.label).foregroundStyle(stage ? Ink.onStage : Ink.muted) }
      } else {
        VStack(spacing: Space.s4) {
          Loader(large: true)
          Text(label).font(Typo.body).foregroundStyle(stage ? Ink.onStage : Ink.muted).multilineTextAlignment(.center).frame(maxWidth: 380)
        }
        .padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .opacity(shown ? 1 : 0)
    .onAppear { withAnimation(.easeOut(duration: Motion.medium).delay(reduced ? 0 : 0.2)) { shown = true } }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityAddTraits(.updatesFrequently)
  }
}

/** A button's words, with the small badge in front while it works: `BusyLabel(busy, "Sign in", "Signing in…")`. */
struct BusyLabel: View {
  let busy: Bool
  let label: String
  let busyLabel: String
  init(_ busy: Bool, _ label: String, _ busyLabel: String) { self.busy = busy; self.label = label; self.busyLabel = busyLabel }
  var body: some View {
    HStack(spacing: 8) {
      if busy { Loader() }
      Text(busy ? busyLabel : label)
    }
  }
}
