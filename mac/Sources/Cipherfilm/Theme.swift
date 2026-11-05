// "Tinte und Papier" (DESIGN.md): ink on warm paper with one deep teal. The photos carry the colour; the chrome stays
// paper, ink and teal. Dark mode keeps the same roles: ink-coloured paper, paper-coloured ink, a lighter teal.
import AppKit
import SwiftUI

enum Ink {
  /** A color that follows the window's appearance. The roles themselves (Ink.paper, Ink.teal, ...) are generated into
   *  Tokens.swift from design/tokens/tokens.json, the same source as the web's and Android's colors. */
  static func c(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1, _ darkAlpha: CGFloat = 1) -> Color {
    Color(nsColor: NSColor(name: nil) { a in
      let isDark = a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      let v = isDark ? dark : light
      return NSColor(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: isDark ? darkAlpha : alpha)
    })
  }

  /** The serif for time and place at a size of its own; the type roles are in Typo. */
  static func serif(_ size: CGFloat) -> Font { .custom("Georgia", size: size) }
}

struct PrimaryButton: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  @State private var hover = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Typo.label)
      .padding(.horizontal, Space.s4).frame(minHeight: Metric.control)
      .foregroundStyle(enabled ? Ink.onTeal : Ink.faint)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(enabled ? (hover || configuration.isPressed ? Ink.tealInk : Ink.teal) : Ink.paperDeep))
      .opacity(enabled && configuration.isPressed ? 0.85 : 1)
      .contentShape(Rectangle())
      .onHover { hover = $0 }
  }
}

/** A sidebar row: teal tint when it is the open screen, paper-deep under the pointer, a shade deeper while pressed.
 *  Shared by the screens and Settings, so they all answer the same way. */
struct SidebarRow: ButtonStyle {
  var current = false
  @State private var hover = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(current ? Ink.tealInk : Ink.muted)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(current ? Ink.tealTint : configuration.isPressed ? Ink.rule : hover ? Ink.paperDeep : .clear))
      .contentShape(Rectangle())
      .onHover { hover = $0 }
  }
}

/** Something that opens a place (an album cover, a person, a status line): paper-deep behind it under the pointer, a
 *  shade deeper while pressed. The highlight reaches 6 pt past the label without moving it. */
struct TileButton: ButtonStyle {
  var radius: CGFloat = Radius.card
  @State private var hover = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(6)
      .background(RoundedRectangle(cornerRadius: radius).fill(configuration.isPressed ? Ink.rule : hover ? Ink.paperDeep : .clear))
      .contentShape(Rectangle())
      .padding(-6)
      .onHover { hover = $0 }
  }
}

/** A text link (Rename, Retry, Sign out): teal, underlined under the pointer, dimmed while pressed. The system's .link
 *  style takes the window's ink colour here and reads as plain text. */
struct TextLink: ButtonStyle {
  @State private var hover = false
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(enabled ? Ink.tealInk : Ink.faint)
      .underline(hover && enabled)
      .opacity(configuration.isPressed ? 0.6 : 1)
      .contentShape(Rectangle())
      .onHover { hover = $0 }
  }
}

struct SecondaryButton: ButtonStyle {
  var danger = false
  @State private var hover = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Typo.label)
      .padding(.horizontal, Space.s4).frame(minHeight: Metric.control)
      .foregroundStyle(danger ? Ink.danger : Ink.tealInk)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(hover || configuration.isPressed ? (danger ? Ink.dangerTint : Ink.tealTint) : Ink.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(hover || configuration.isPressed ? (danger ? Ink.danger : Ink.teal) : Ink.ruleStrong, lineWidth: 1))
      .opacity(configuration.isPressed ? 0.85 : 1)
      .onHover { hover = $0 }
      .contentShape(Rectangle())
  }
}

/** A text field on card white with a sand border that turns teal while it has the focus, as on the web (a plain
 *  field draws no focus ring of its own). */
struct Field: ViewModifier {
  @FocusState private var focused: Bool
  func body(content: Content) -> some View {
    content.textFieldStyle(.plain).font(Typo.body).focused($focused).padding(.horizontal, Space.s3).frame(height: Metric.field)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Ink.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(focused ? Ink.teal : Ink.ruleStrong, lineWidth: focused ? 2 : 1))
  }
}

extension View {
  func field() -> some View { modifier(Field()) }
}

/** A brick-wash note for errors, a moss-wash one for confirmations. */
struct Note: View {
  let text: String
  var ok = false
  var close: (() -> Void)?
  var body: some View {
    HStack(alignment: .top) {
      Text(text).font(Typo.label).frame(maxWidth: .infinity, alignment: .leading)
      if let close { Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Dismiss").accessibilityLabel("Dismiss") }
    }
    .foregroundStyle(ok ? Ink.ok : Ink.danger).padding(Space.s3)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(ok ? Ink.okTint : Ink.dangerTint))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(ok ? Ink.ok : Ink.danger, lineWidth: 1))
  }
}

/** The empty state: a dashed sand border on deep paper with a teal-wash icon disc. */
struct EmptyState: View {
  let icon: String
  let title: String
  let text: String
  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: icon).font(.system(size: 26, weight: .regular)).foregroundStyle(Ink.teal)
        .frame(width: 64, height: 64).background(Circle().fill(Ink.tealTint))
      Text(title).font(Typo.dialog).foregroundStyle(Ink.ink)
      Text(text).font(Typo.body).foregroundStyle(Ink.muted).multilineTextAlignment(.center).frame(maxWidth: 380)
    }
    .padding(40).frame(maxWidth: 560)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.paperDeep))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.ruleStrong, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
  }
}

/** The mark, "Photo lock" (design/icon): one padlock whose body is the photo, with the ridge and sun cut out, on the
 *  24 grid. `shape` is shared by the in-app mark and the menu-bar icon. */
enum PhotoLock {
  /** Shackle and body in 24-grid units, y down, as two paths: fill the shackle normally and the body with the even-odd
   *  rule, so the ridge and sun are cut out of the body and the shackle's legs join it without a seam. */
  static func paths(scale s: CGFloat, dx: CGFloat = 0, dy: CGFloat = 0) -> (shackle: CGPath, body: CGPath) {
    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: dx + x * s, y: dy + y * s) }
    let shackle = CGMutablePath()
    shackle.move(to: pt(6.6, 10)); shackle.addLine(to: pt(6.6, 7))
    shackle.addArc(center: pt(12, 7), radius: 5.4 * s, startAngle: .pi, endAngle: 0, clockwise: false)
    shackle.addLine(to: pt(17.4, 10)); shackle.addLine(to: pt(14.4, 10)); shackle.addLine(to: pt(14.4, 7))
    shackle.addArc(center: pt(12, 7), radius: 2.4 * s, startAngle: 0, endAngle: .pi, clockwise: true)
    shackle.addLine(to: pt(9.6, 10)); shackle.closeSubpath()
    let body = CGMutablePath()
    body.addPath(CGPath(roundedRect: CGRect(x: dx + 3.6 * s, y: dy + 9.4 * s, width: 16.8 * s, height: 12.6 * s),
                        cornerWidth: 2.2 * s, cornerHeight: 2.2 * s, transform: nil))
    body.move(to: pt(6.2, 19.8))
    for (x, y) in [(6.2, 18.0), (10.2, 13.6), (13.6, 17.2), (17.8, 14.4), (17.8, 19.8)] { body.addLine(to: pt(CGFloat(x), CGFloat(y))) }
    body.closeSubpath()
    body.addEllipse(in: CGRect(x: dx + 13.7 * s, y: dy + 10.9 * s, width: 3.4 * s, height: 3.4 * s))
    return (shackle, body)
  }
}

/** The app's mark in the theme's teal. */
struct Mark: View {
  var size: CGFloat = 22
  var body: some View {
    Canvas { ctx, sz in
      let p = PhotoLock.paths(scale: sz.width / 24)
      ctx.fill(Path(p.shackle), with: .color(Ink.teal))
      ctx.fill(Path(p.body), with: .color(Ink.teal), style: FillStyle(eoFill: true))
    }
    .frame(width: size, height: size)
  }
}

extension Date {
  var dayTitle: String {
    let cal = Calendar.current
    if cal.isDateInToday(self) { return "Today" }
    if cal.isDateInYesterday(self) { return "Yesterday" }
    let sameYear = cal.component(.year, from: self) == cal.component(.year, from: Date())
    return formatted(.dateTime.weekday(.wide).day().month(.wide).year(sameYear ? .omitted : .defaultDigits))
  }
}

func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }

/** The menu-bar icon: the app's mark (Photo lock) as a template image at the menu bar's full height, with a dot
 *  while something is being uploaded, exported or indexed. */
enum MenuBarIcon {
  @MainActor private static var cache: [Bool: NSImage] = [:]

  @MainActor static func image(busy: Bool) -> NSImage {
    if let hit = cache[busy] { return hit }
    let img = NSImage(size: NSSize(width: 22, height: 18), flipped: true) { _ in
      NSColor.black.set()
      // the mark at the menu bar's full height: the 24-grid shape spans y 1.6...22, scaled to 0...17.5
      let k: CGFloat = 0.86
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      let p = PhotoLock.paths(scale: k, dx: 11 - 12 * k, dy: -1.6 * k)
      ctx.addPath(p.shackle); ctx.fillPath()
      ctx.addPath(p.body); ctx.fillPath(using: .evenOdd)
      if busy {
        NSGraphicsContext.current?.compositingOperation = .clear
        NSBezierPath(ovalIn: NSRect(x: 15.2, y: -0.6, width: 7.4, height: 7.4)).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        NSBezierPath(ovalIn: NSRect(x: 16.4, y: 0.6, width: 5, height: 5)).fill()
      }
      return true
    }
    img.isTemplate = true
    img.accessibilityDescription = "Cipherfilm"
    cache[busy] = img
    return img
  }
}
