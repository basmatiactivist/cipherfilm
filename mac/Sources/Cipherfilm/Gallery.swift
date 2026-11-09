// The timeline as the web app lays it out: one serif heading per capture day, then justified rows in which every photo
// keeps its own aspect ratio (0.4 to 4), 4 px apart, about 210 px high. A click opens, a long press or ⌘-click selects
// (⇧ extends), the arrow keys move the selection, Space or Return opens it, ⌫ moves it to the trash.
import AppKit
import CipherfilmCore
import SwiftUI

struct GridSection: Identifiable {
  let id: String
  let title: String?
  let items: [Item]
  var date: Date { items.first?.date ?? .distantPast }
  var year: Int { Calendar.current.component(.year, from: date) }
}

enum Grouping { case day, none }

func sections(_ items: [Item], _ g: Grouping) -> [GridSection] {
  guard g == .day else { return [GridSection(id: "all", title: nil, items: items)] }
  var out: [GridSection] = []
  let cal = Calendar.current
  var cur: [Item] = []
  var curDay: DateComponents?
  for it in items {
    let d = cal.dateComponents([.year, .month, .day], from: it.date)
    if d != curDay, !cur.isEmpty, let c = curDay { out.append(GridSection(id: dayId(c), title: cur[0].date.dayTitle, items: cur)); cur = [] }
    curDay = d
    cur.append(it)
  }
  if !cur.isEmpty, let d = curDay { out.append(GridSection(id: dayId(d), title: cur[0].date.dayTitle, items: cur)) }
  return out
}

/** A day's section id; a component the calendar didn't give counts as 0. */
private func dayId(_ d: DateComponents) -> String { "\(d.year ?? 0)-\(d.month ?? 0)-\(d.day ?? 0)" }

struct Row: Identifiable {
  let id: String
  let items: [Item]
  let height: CGFloat
  let widths: [CGFloat]
}

func justify(_ items: [Item], width: CGFloat, target: CGFloat, gap: CGFloat = 4) -> [Row] {
  var rows: [Row] = []
  var cur: [Item] = []
  var sum: CGFloat = 0
  for it in items {
    cur.append(it); sum += it.aspect
    let natural = sum * target + gap * CGFloat(cur.count - 1)
    if natural >= width {
      let h = (width - gap * CGFloat(cur.count - 1)) / sum
      rows.append(Row(id: cur[0].id, items: cur, height: h, widths: cur.map { $0.aspect * h }))
      cur = []; sum = 0
    }
  }
  if !cur.isEmpty { rows.append(Row(id: cur[0].id, items: cur, height: target, widths: cur.map { $0.aspect * target })) }
  return rows
}

@MainActor @Observable
final class Selection {
  var ids = Set<String>()
  var anchor: String?

  func toggle(_ id: String) {
    if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
    anchor = id
  }

  func click(_ id: String, in order: [Item], modifiers: NSEvent.ModifierFlags) {
    if modifiers.contains(.command) || (!modifiers.contains(.shift) && !ids.isEmpty) {
      if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
      anchor = id
    } else if modifiers.contains(.shift), let a = anchor, let i = order.firstIndex(where: { $0.id == a }), let j = order.firstIndex(where: { $0.id == id }) {
      ids.formUnion(order[min(i, j)...max(i, j)].map(\.id))
    } else {
      ids = [id]; anchor = id
    }
  }

  func clear() { ids = []; anchor = nil }
}

struct PhotoGrid: View {
  @Environment(AppModel.self) private var model
  let items: [Item]
  var grouping: Grouping = .day
  var trashMode = false
  var albumId: String?
  @Bindable var selection: Selection
  /** called when the end of the grid comes into view (more search results to show) */
  var more: (() -> Void)?
  let open: (Item, [Item]) -> Void
  @State private var width: CGFloat = 900
  @FocusState private var focused: Bool
  @State private var stepped: String?
  @Environment(Navigator.self) private var nav

  var body: some View {
    let secs = sections(items, grouping)
    let target: CGFloat = width < 520 ? 120 : width < 900 ? 170 : 210
    let years = grouping == .day ? Array(Set(secs.map(\.year))).sorted(by: >) : []
    let rowsBySec = secs.map { justify($0.items, width: max(100, width), target: target) }
    ScrollViewReader { proxy in
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 4, pinnedViews: []) {
        ForEach(Array(zip(secs, rowsBySec)), id: \.0.id) { s, rows in
          if let t = s.title {
            Text(t).font(Typo.heading).foregroundStyle(Ink.ink).frame(height: 44, alignment: .bottomLeading).padding(.bottom, 2).id(s.id)
          }
          ForEach(rows) { row in
            HStack(spacing: 4) {
              ForEach(Array(zip(row.items, row.widths)), id: \.0.id) { it, w in
                Tile(item: it, selected: selection.ids.contains(it.id))
                  .frame(width: w, height: row.height)
                  .id(it.id)
                  // a click opens; a long press starts selecting; while something is selected, clicks pick
                  .gesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in selection.toggle(it.id); focused = true }
                    .exclusively(before: TapGesture().onEnded {
                      focused = true
                      let mods = NSEvent.modifierFlags
                      if mods.contains(.command) || mods.contains(.shift) || !selection.ids.isEmpty {
                        selection.click(it.id, in: items, modifiers: mods)
                      } else {
                        open(it, items)
                      }
                    }))
                  .contextMenu { ItemMenu(ids: menuIds(it), trashMode: trashMode, albumId: albumId, open: { open(it, items) }) }
                  .onDrag { Outbox.provider(it) }
              }
            }
          }
        }
        if let more { Color.clear.frame(height: 1).onAppear(perform: more) }
      }
      .padding(.leading, 28).padding(.trailing, years.count > 1 ? 56 : 28).padding(.bottom, 80)
      .background(GeometryReader { g in Color.clear.onAppear { width = g.size.width - (years.count > 1 ? 84 : 56) }.onChange(of: g.size.width) { _, w in width = w - (years.count > 1 ? 84 : 56) } })
    }
    .overlay(alignment: .trailing) {
      if years.count > 1 { YearScrubber(years: years) { y in if let s = secs.first(where: { $0.year == y }) { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(s.id, anchor: .top) } } } }
    }
    .onChange(of: nav.jump) { _, d in
      guard let d else { return }
      let end = Calendar.current.startOfDay(for: d).addingTimeInterval(86400)
      if let s = secs.first(where: { $0.date < end }) ?? secs.last { proxy.scrollTo(s.id, anchor: .top) }
      nav.jump = nil
    }
    .onChange(of: stepped) { _, id in
      guard let id else { return }
      withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(id, anchor: nil) }
      stepped = nil
    }
    }
    .focusable()
    .focusEffectDisabled()
    .focused($focused)
    .onKeyPress(.space) { if let id = selection.anchor, let it = items.first(where: { $0.id == id }) { open(it, items) }; return .handled }
    .onKeyPress(.return) { if let id = selection.anchor, let it = items.first(where: { $0.id == id }) { open(it, items) }; return .handled }
    .onKeyPress(.escape) { selection.clear(); return .handled }
    .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow]) { k in step(k, rowsBySec.flatMap { $0 }) }
    .onKeyPress(.delete) {
      guard !trashMode, !selection.ids.isEmpty else { return .ignored }
      model.moveToTrash(Array(selection.ids)); selection.clear(); return .handled
    }
    .onKeyPress(characters: .init(charactersIn: "a"), phases: .down) { k in
      guard k.modifiers.contains(.command) else { return .ignored }
      selection.ids = Set(items.map(\.id)); return .handled
    }
  }

  /** Arrow keys: left and right in date order, up and down to the photo above or below; ⇧ adds to the selection. */
  private func step(_ k: KeyPress, _ rows: [Row]) -> KeyPress.Result {
    guard !items.isEmpty else { return .ignored }
    var next: String?
    if let a = selection.anchor, let i = items.firstIndex(where: { $0.id == a }) {
      switch k.key {
      case .leftArrow: next = items[max(0, i - 1)].id
      case .rightArrow: next = items[min(items.count - 1, i + 1)].id
      default:
        guard let r = rows.firstIndex(where: { $0.items.contains { $0.id == a } }) else { return .ignored }
        let t = k.key == .upArrow ? r - 1 : r + 1
        guard rows.indices.contains(t) else { return .handled }
        func centers(_ row: Row) -> [CGFloat] {
          var x: CGFloat = 0
          return row.widths.map { w in defer { x += w + 4 }; return x + w / 2 }
        }
        let c = centers(rows[r])[rows[r].items.firstIndex { $0.id == a }!]
        let cs = centers(rows[t])
        next = rows[t].items[cs.indices.min { abs(cs[$0] - c) < abs(cs[$1] - c) }!].id
      }
    } else {
      next = items[0].id
    }
    guard let next else { return .ignored }
    if k.modifiers.contains(.shift) { selection.ids.insert(next) } else { selection.ids = [next] }
    selection.anchor = next
    stepped = next
    return .handled
  }

  private func menuIds(_ it: Item) -> [String] { selection.ids.contains(it.id) ? Array(selection.ids) : [it.id] }
}

/** The years along the right edge, newest at the top; a click scrolls to the year (the web app's scrubber). */
struct YearScrubber: View {
  let years: [Int]
  let go: (Int) -> Void
  @State private var hover: Int?
  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(spacing: 2) {
        ForEach(years, id: \.self) { y in
          Button { go(y) } label: {
            Text(String(y)).font(Typo.small.weight(.semibold).monospacedDigit())
              .foregroundStyle(hover == y ? Ink.tealInk : Ink.muted)
              .frame(width: 44, height: 22)
              .background(RoundedRectangle(cornerRadius: Radius.pill).fill(hover == y ? Ink.tealTint : .clear))
          }.buttonStyle(.plain).onHover { hover = $0 ? y : nil }
        }
      }.padding(.vertical, 12)
    }
    .frame(width: 48).padding(.trailing, 4)
  }
}

struct Tile: View {
  @Environment(AppModel.self) private var model
  let item: Item
  let selected: Bool
  @State private var image: NSImage?
  @State private var hover = false

  var body: some View {
    ZStack {
      Rectangle().fill(Ink.paperDeep)
      if item.broken {
        VStack(spacing: 4) {
          Image(systemName: "exclamationmark.triangle").foregroundStyle(Ink.danger)
          Text("Couldn't be verified").font(Typo.small.weight(.semibold)).foregroundStyle(Ink.danger)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Ink.dangerTint)
      } else if let image {
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
      } else if !item.hasThumb {
        Image(systemName: item.kind == .video ? "film" : "doc").font(.system(size: 22)).foregroundStyle(Ink.faint)
      }
      if hover { Rectangle().fill(Ink.ink.opacity(0.12)) }
    }
    .clipped()
    .clipShape(RoundedRectangle(cornerRadius: Radius.tile))
    .overlay(alignment: .bottomLeading) {
      if item.kind == .video {
        HStack(spacing: 3) {
          Image(systemName: "play.fill").font(.system(size: 8))
          if let d = item.meta?.duration { Text(Duration.seconds(d).formatted(.time(pattern: d >= 3600 ? .hourMinuteSecond : .minuteSecond))).font(Typo.micro.weight(.semibold).monospacedDigit()) }
        }
        .foregroundStyle(Ink.onBadge).padding(.horizontal, 7).frame(height: 22).background(Capsule().fill(Ink.badge)).padding(6)
      }
    }
    .overlay(alignment: .bottomTrailing) {
      if item.favorite { Image(systemName: "heart.fill").font(Typo.small).foregroundStyle(Ink.onBadge).frame(width: 22, height: 22).background(Circle().fill(Ink.badge)).padding(6) }
    }
    .overlay {
      if selected { RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Ink.teal, lineWidth: 4) }
    }
    .overlay(alignment: .topLeading) {
      if selected {
        Image(systemName: "checkmark").font(Typo.small.weight(.bold)).foregroundStyle(Ink.onTeal)
          .frame(width: 22, height: 22).background(Circle().fill(Ink.teal)).padding(6)
      }
    }
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(item.kind == .video ? "Video" : "Photo"), \(item.date.formatted(date: .long, time: .shortened))\(item.favorite ? ", favorite" : "")")
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .task(id: item.id) {
      if let hit = model.images.cachedThumb(item.id) { image = hit; return }
      guard let v = model.vault else { return }
      image = await model.images.thumb(item, v)
    }
  }
}

/** The actions on one or more items (right click, the viewer's toolbar). */
struct ItemMenu: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let ids: [String]
  var trashMode = false
  var albumId: String?
  var open: (() -> Void)?

  var body: some View {
    if trashMode {
      Button("Restore") { model.restore(ids) }
      Button("Delete Forever…") { nav.confirmPurge = ids }
    } else {
      if let open, ids.count == 1 { Button("Open") { open() } }
      let fav = ids.allSatisfy { model.item($0)?.favorite == true }
      Button(fav ? "Remove from Favorites" : "Add to Favorites") { model.setFavorite(ids, !fav) }
      Menu("Add to Album") {
        ForEach(model.albums.filter { !$0.broken }) { a in Button(a.name) { model.perform { try await $0.addToAlbum(a.id, ids) } } }
        Divider()
        Button("New Album…") { nav.newAlbumFor = ids }
      }
      if let albumId { Button("Remove from Album") { model.perform { try await $0.removeFromAlbum(albumId, ids) } } }
      if ids.count == 1, model.search.ready { Button("Photos Like This One") { nav.showSimilar(ids[0]) } }
      Divider()
      Button("Share…") { Outbox.share(ids.compactMap { model.item($0) }, model) }
      Button(ids.count == 1 ? "Save Original…" : "Save Originals…") { Saver.save(ids.compactMap { model.item($0) }, model) }
      Divider()
      Button("Move to Trash") { model.moveToTrash(ids) }
    }
  }
}

enum Saver {
  /** Decrypts the originals into a place the person picks. */
  @MainActor static func save(_ items: [Item], _ model: AppModel) {
    guard let vault = model.vault, !items.isEmpty else { return }
    let staging = Outbox.dir.appendingPathComponent("staging", isDirectory: true)
    if items.count == 1, let it = items.first {
      let p = NSSavePanel()
      p.nameFieldStringValue = it.name.isEmpty ? "photo" : it.name
      p.canCreateDirectories = true
      guard p.runModal() == .OK, let url = p.url else { return }
      Task {
        model.working = "Saving \(url.lastPathComponent)…"
        defer { model.working = nil }
        do {
          try await vault.saveOriginal(it, to: url, staging: staging)
          try? FileManager.default.setAttributes([.creationDate: it.date, .modificationDate: it.date], ofItemAtPath: url.path)
          NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
          model.alert = "\(it.name) couldn't be saved: \(error.localizedDescription)"
        }
      }
    } else {
      let p = NSOpenPanel()
      p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true; p.prompt = "Save Here"
      p.message = "Choose a folder for the \(items.count) originals."
      guard p.runModal() == .OK, let dir = p.url else { return }
      Task {
        var taken = Set<String>()
        var saved: [URL] = []
        var failed: [String] = []
        for (n, it) in items.enumerated() {
          model.working = "Saving \(n + 1) of \(items.count)…"
          // every candidate is one clean path component, the numbered ones too
          let first = FileName.of(it)
          var name = first
          var k = 2
          while taken.contains(name.lowercased()) || FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) {
            name = FileName.numbered(first, k); k += 1
          }
          taken.insert(name.lowercased())
          do {
            guard let url = FileName.inside(dir, name) else { throw CryptoError.failed("bad file name") }
            try await vault.saveOriginal(it, to: url, staging: staging)
            try? FileManager.default.setAttributes([.creationDate: it.date, .modificationDate: it.date], ofItemAtPath: url.path)
            saved.append(url)
          } catch {
            failed.append("\(it.name): \(error.localizedDescription)")
          }
        }
        model.working = nil
        if !saved.isEmpty { NSWorkspace.shared.activateFileViewerSelecting(saved) }
        if !failed.isEmpty { model.alert = "\(failed.count) couldn't be saved.\n" + failed.prefix(5).joined(separator: "\n") }
      }
    }
  }
}
