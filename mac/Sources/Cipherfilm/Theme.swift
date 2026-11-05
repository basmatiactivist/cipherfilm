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

/** The app's mark: a photo print in ink line, locked by a teal padlock over its lower right corner. */
struct Mark: View {
  var size: CGFloat = 22
  var body: some View {
    Canvas { ctx, sz in
      let s = sz.width / 24
      let print = Path(roundedRect: CGRect(x: 2 * s, y: 3 * s, width: 16 * s, height: 14 * s), cornerRadius: 1.5 * s)
      ctx.stroke(print, with: .color(Ink.ink), lineWidth: 1.8 * s)
      var ridge = Path()
      ridge.move(to: CGPoint(x: 4.5 * s, y: 14 * s)); ridge.addLine(to: CGPoint(x: 8.5 * s, y: 9 * s)); ridge.addLine(to: CGPoint(x: 11.5 * s, y: 12 * s))
      ridge.addLine(to: CGPoint(x: 13.5 * s, y: 10 * s)); ridge.addLine(to: CGPoint(x: 15.5 * s, y: 12.5 * s))
      ctx.stroke(ridge, with: .color(Ink.ink), style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round, lineJoin: .round))
      ctx.fill(Path(roundedRect: CGRect(x: 12 * s, y: 13 * s, width: 11 * s, height: 10 * s), cornerRadius: 2 * s), with: .color(Ink.paper))
      ctx.fill(Path(roundedRect: CGRect(x: 13 * s, y: 15.5 * s, width: 9 * s, height: 7 * s), cornerRadius: 1.4 * s), with: .color(Ink.teal))
      var shackle = Path()
      shackle.addArc(center: CGPoint(x: 17.5 * s, y: 15.5 * s), radius: 2.6 * s, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
      ctx.stroke(shackle, with: .color(Ink.teal), lineWidth: 1.8 * s)
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

/** The menu-bar icon: the app's mark (print and padlock) as a template image at the menu bar's full height, with a dot
 *  while something is being uploaded, exported or indexed. */
enum MenuBarIcon {
  @MainActor private static var cache: [Bool: NSImage] = [:]

  @MainActor static func image(busy: Bool) -> NSImage {
    if let hit = cache[busy] { return hit }
    let img = NSImage(size: NSSize(width: 22, height: 18), flipped: true) { _ in
      NSColor.black.set()
      let print = NSBezierPath(roundedRect: NSRect(x: 1.2, y: 2.2, width: 14.6, height: 12.6), xRadius: 2.4, yRadius: 2.4)
      print.lineWidth = 1.7
      print.stroke()
      let ridge = NSBezierPath()
      ridge.move(to: NSPoint(x: 1.8, y: 12.4)); ridge.line(to: NSPoint(x: 6.2, y: 8.2)); ridge.line(to: NSPoint(x: 9.2, y: 11))
      ridge.line(to: NSPoint(x: 11.6, y: 9.2))
      ridge.lineWidth = 1.6; ridge.lineCapStyle = .round; ridge.lineJoinStyle = .round
      ridge.stroke()
      NSBezierPath(ovalIn: NSRect(x: 10.4, y: 4.4, width: 2.6, height: 2.6)).fill()
      // the padlock over the lower right corner, cut free from the print
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(roundedRect: NSRect(x: 11.2, y: 7.6, width: 10.4, height: 10.4), xRadius: 2.2, yRadius: 2.2).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      NSBezierPath(roundedRect: NSRect(x: 12.6, y: 11.4, width: 7.8, height: 6.2), xRadius: 1.4, yRadius: 1.4).fill()
      let shackle = NSBezierPath()
      shackle.move(to: NSPoint(x: 14.3, y: 11.6)); shackle.line(to: NSPoint(x: 14.3, y: 10.4))
      shackle.appendArc(withCenter: NSPoint(x: 16.5, y: 10.4), radius: 2.2, startAngle: 180, endAngle: 0, clockwise: false)
      shackle.line(to: NSPoint(x: 18.7, y: 11.6))
      shackle.lineWidth = 1.6
      shackle.stroke()
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
