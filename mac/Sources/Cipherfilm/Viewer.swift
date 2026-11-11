// The viewer takes the whole window: the photo on black as large as fits (the preview at once, the original when it
// has arrived), a bar of quick actions over it, a filmstrip of the neighbours under it, and the info column beside it
// with who is in the photo (name a face right there). Videos stream and are decrypted in memory.
// Keys: ← → move, Esc closes, I info, F favorite, ⌫ trash; the Photo menu has the rest (⇧⌘S share, ⇧⌘E save…).
import AVKit
import CipherfilmCore
import SwiftUI

struct Viewer: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let state: ViewerState
  @AppStorage("viewerInfo") private var info = true
  @FocusState private var focused: Bool

  var body: some View {
    let item = model.item(state.id) ?? model.trash.first { $0.id == state.id }
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        topBar(item)
        ZStack {
          if let item {
            if item.kind == .video { VideoView(item: item).id(item.id) } else { PhotoView(item: item).id(item.pictureKey) }
          }
          HStack {
            NavArrow(icon: "chevron.left", enabled: state.index > 0) { move(-1) }
            Spacer()
            NavArrow(icon: "chevron.right", enabled: state.index < state.ids.count - 1) { move(1) }
          }.padding(.horizontal, 14)
        }
        if state.ids.count > 1 { Filmstrip(state: state) }
      }
      .background(Ink.stage)
      if info, let item {
        InfoPanel(item: item).frame(width: 320).transition(.move(edge: .trailing))
      }
    }
    .background(Ink.stage)
    .focusable()
    .focusEffectDisabled()
    .focused($focused)
    .onAppear { focused = true }
    .onKeyPress(.leftArrow) { move(-1); return .handled }
    .onKeyPress(.rightArrow) { move(1); return .handled }
    .onKeyPress(.escape) { nav.viewer = nil; return .handled }
    .onKeyPress(.delete) { if let item, item.trashedAt == nil { trash(item) }; return .handled }
    .onKeyPress(characters: .init(charactersIn: "iIfF")) { k in
      if k.characters.lowercased() == "i" { withAnimation(.easeOut(duration: Motion.fast)) { info.toggle() } }
      else if let item, item.trashedAt == nil { model.setFavorite([item.id], !item.favorite) }
      return .handled
    }
  }

  private func move(_ d: Int) {
    let i = state.index + d
    guard i >= 0, i < state.ids.count else { return }
    nav.viewer = ViewerState(ids: state.ids, index: i)
  }

  private func trash(_ item: Item) {
    model.moveToTrash([item.id])
    if state.ids.count > 1 {
      var ids = state.ids; ids.remove(at: state.index)
      nav.viewer = ViewerState(ids: ids, index: min(state.index, ids.count - 1))
    } else {
      nav.viewer = nil
    }
  }

  /** Close and name on the left (clear of the window buttons), the quick actions on the right. */
  @ViewBuilder private func topBar(_ item: Item?) -> some View {
    HStack(spacing: 4) {
      LightboxButton(icon: "chevron.backward", help: "Back to the photos (Esc)") { nav.viewer = nil }
      if let item {
        VStack(alignment: .leading, spacing: 1) {
          Text(item.name).font(Typo.label).lineLimit(1)
          Text(item.date.formatted(date: .long, time: .shortened) + "  ·  \(state.index + 1) of \(state.ids.count)").font(Typo.small).opacity(0.7)
        }.foregroundStyle(Ink.onStage).padding(.leading, 4)
        Spacer(minLength: 12)
        if item.trashedAt == nil {
          LightboxButton(icon: item.favorite ? "heart.fill" : "heart", help: item.favorite ? "Remove from Favorites (F, ⇧⌘F)" : "Add to Favorites (F, ⇧⌘F)") { model.setFavorite([item.id], !item.favorite) }
          Menu {
            ForEach(model.albums.filter { !$0.broken }) { a in Button(a.name) { model.perform { try await $0.addToAlbum(a.id, [item.id]) } } }
            Divider()
            Button("New Album…") { nav.newAlbumFor = [item.id] }
          } label: { LightboxIcon(icon: "rectangle.stack.badge.plus") }
            .accessibilityLabel("Add to Album")
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize().help("Add to Album (⌃⌘A)")
          LightboxButton(icon: "square.and.arrow.up", help: "Share (⇧⌘S)") { Outbox.share([item], model) }
          LightboxButton(icon: "arrow.down.to.line", help: "Save Original (⇧⌘E)") { Saver.save([item], model) }
          if model.search.ready { LightboxButton(icon: "sparkle.magnifyingglass", help: "Photos Like This One (⌘K)") { nav.showSimilar(item.id) } }
          LightboxButton(icon: "trash", help: "Move to Trash (⌘⌫)") { trash(item) }
        } else {
          LightboxButton(icon: "arrow.uturn.backward", help: "Restore") { model.restore([item.id]); nav.viewer = nil }
        }
        Rectangle().fill(Ink.stageOn).frame(width: 1, height: 22).padding(.horizontal, 4)
        LightboxButton(icon: "info.circle", help: "Info (I)", on: info) { withAnimation(.easeOut(duration: Motion.fast)) { info.toggle() } }
      } else {
        Spacer()
      }
    }
    .padding(.leading, 80).padding(.trailing, 12).frame(height: 52)
    .background(Ink.stage)
  }
}

struct LightboxIcon: View {
  let icon: String
  var on = false
  var pressed = false
  @State private var hover = false
  var body: some View {
    Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Ink.onStage).frame(width: 36, height: 36)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(pressed ? Ink.stageNavHover : on ? Ink.stageOn : hover ? Ink.stageHover : .clear))
      .contentShape(Rectangle())
      .onHover { hover = $0 }
  }
}

/** The viewer's icon buttons: lighter under the pointer, lighter still while pressed or switched on. */
struct LightboxStyle: ButtonStyle {
  let icon: String
  var on = false
  func makeBody(configuration: Configuration) -> some View { LightboxIcon(icon: icon, on: on, pressed: configuration.isPressed) }
}

struct LightboxButton: View {
  let icon: String
  let help: String
  var on = false
  let action: () -> Void
  var body: some View {
    // VoiceOver reads the tooltip without its shortcut
    Button(help.components(separatedBy: " (").first ?? help, action: action)
      .buttonStyle(LightboxStyle(icon: icon, on: on)).help(help)
      .accessibilityAddTraits(on ? .isSelected : [])
  }
}

struct NavArrow: View {
  let icon: String
  let enabled: Bool
  let action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(Ink.onStage).frame(width: 44, height: 44)
    }
    .buttonStyle(ArrowStyle(hover: hover)).onHover { hover = $0 }
    .opacity(enabled ? 1 : 0).disabled(!enabled)
    .accessibilityLabel(icon.contains("backward") || icon.contains("left") ? "Previous" : "Next")
  }

  struct ArrowStyle: ButtonStyle {
    let hover: Bool
    func makeBody(configuration: Configuration) -> some View {
      configuration.label.background(Circle().fill(Ink.stage.opacity(configuration.isPressed ? 0.8 : hover ? 0.65 : 0.45)))
    }
  }
}

/** The neighbours as small thumbnails under the photo; a click goes there. */
struct Filmstrip: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let state: ViewerState

  var body: some View {
    let lo = max(0, state.index - 30), hi = min(state.ids.count, state.index + 31)
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 4) {
          ForEach(lo..<hi, id: \.self) { i in
            if let it = model.item(state.ids[i]) ?? model.trash.first(where: { $0.id == state.ids[i] }) {
              StripThumb(item: it, current: i == state.index)
                .id(i)
                .onTapGesture { nav.viewer = ViewerState(ids: state.ids, index: i) }
            }
          }
        }.padding(.horizontal, 12)
      }
      .frame(height: 64)
      .onAppear { proxy.scrollTo(state.index, anchor: .center) }
      .onChange(of: state.index) { _, i in withAnimation(.easeOut(duration: Motion.fast)) { proxy.scrollTo(i, anchor: .center) } }
    }
    .padding(.vertical, 6)
    .background(Ink.stage)
  }
}

struct StripThumb: View {
  @Environment(AppModel.self) private var model
  let item: Item
  let current: Bool
  @State private var image: NSImage?
  @State private var hover = false
  var body: some View {
    ZStack {
      Rectangle().fill(Ink.stageWell)
      if let image { Image(nsImage: image).resizable().aspectRatio(contentMode: .fill) }
    }
    .frame(width: current ? 64 : 46, height: 52)
    .clipShape(RoundedRectangle(cornerRadius: Radius.pill))
    .overlay(RoundedRectangle(cornerRadius: Radius.pill).strokeBorder(current ? Ink.onStage : .clear, lineWidth: 2))
    .opacity(current || hover ? 1 : 0.6)
    .onHover { hover = $0 }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.date.formatted(date: .long, time: .shortened))
    .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    .task(id: item.pictureKey) {
      if let hit = model.images.cachedThumb(item) { image = hit; return }
      if let v = model.vault { image = await model.images.thumb(item, v) }
    }
  }
}

struct PhotoView: View {
  @Environment(AppModel.self) private var model
  let item: Item
  @State private var image: NSImage?
  @State private var zoom: CGFloat = 1
  @State private var base: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var drag: CGSize = .zero

  var body: some View {
    ZStack {
      if item.broken {
        Text("Couldn't verify this item, so it isn't shown.").foregroundStyle(Ink.stageMuted)
      } else if let image {
        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
          .scaleEffect(zoom)
          .offset(x: offset.width + drag.width, y: offset.height + drag.height)
          .gesture(MagnifyGesture().onChanged { zoom = max(1, min(8, base * $0.magnification)) }.onEnded { _ in base = zoom; if zoom == 1 { offset = .zero } })
          .simultaneousGesture(DragGesture().onChanged { if zoom > 1 { drag = $0.translation } }.onEnded { v in if zoom > 1 { offset.width += v.translation.width; offset.height += v.translation.height }; drag = .zero })
          .onTapGesture(count: 2) { withAnimation(.easeOut(duration: Motion.fast)) { if zoom > 1 { zoom = 1; offset = .zero } else { zoom = 2.5 }; base = zoom } }
          .padding(16)
      } else {
        Loading(label: "Decrypting…", stage: true)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .clipped()
    .task {
      guard let v = model.vault else { return }
      if let t = model.images.cachedThumb(item) { image = t }
      if let p = await model.images.preview(item, v) { image = p }
      if let o = await model.images.original(item, v) { image = o }
    }
  }
}

struct VideoView: View {
  @Environment(AppModel.self) private var model
  let item: Item
  @State private var player: AVPlayer?
  @State private var loader: VideoLoader?

  var body: some View {
    ZStack {
      if let player {
        PlayerView(player: player)
      } else {
        Loading(label: "Preparing video…", stage: true)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear {
      guard let v = model.vault, !item.broken else { return }
      let l = VideoLoader(item: item, vault: v)
      loader = l
      let p = AVPlayer(playerItem: AVPlayerItem(asset: l.asset()))
      player = p
      p.play()
    }
    .onDisappear { player?.pause(); player = nil; loader?.close(); loader = nil }
  }
}

/** AppKit's player view: native controls, full screen, picture in picture. */
struct PlayerView: NSViewRepresentable {
  let player: AVPlayer
  func makeNSView(context: Context) -> AVPlayerView {
    let v = AVPlayerView()
    v.controlsStyle = .floating
    v.showsFullScreenToggleButton = true
    v.allowsPictureInPicturePlayback = true
    v.player = player
    return v
  }
  func updateNSView(_ v: AVPlayerView, context: Context) { if v.player !== player { v.player = player } }
}

/** The info column: who is in the photo first (each face, named or not), then the details. */
struct InfoPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let item: Item
  @State private var faces: [SearchEngine.FaceInPhoto] = []
  @State private var naming: SearchEngine.FaceInPhoto?
  @State private var error: String?
  /** the town and country of the photo's coordinates, looked up on this Mac (PlaceBook) */
  @State private var placeName: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text("Info").font(Typo.dialog).padding(.top, 14)
        if model.settings.search && model.settings.faces {
          VStack(alignment: .leading, spacing: 10) {
            Text("People").font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.muted)
            if faces.isEmpty {
              Text(model.search.index.has(item.id) ? "No faces found in this photo." : "Not indexed yet. Faces show up once this photo is indexed.")
                .font(Typo.caption).foregroundStyle(Ink.faint).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(faces) { f in
              HStack(spacing: 10) {
                FaceImage(cover: f.cover, size: 40)
                if let name = f.group?.person?.name, !name.isEmpty {
                  Button { nav.go(.person(f.group!.key)) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                      Text(name).font(Typo.label).foregroundStyle(Ink.ink)
                      Text("\(f.group!.items.count) photo\(f.group!.items.count == 1 ? "" : "s") · show all").font(Typo.small).foregroundStyle(Ink.teal)
                    }
                  }.buttonStyle(TileButton(radius: 6))
                  Spacer()
                  Button("Rename") { naming = f }.buttonStyle(TextLink()).font(Typo.caption)
                } else {
                  VStack(alignment: .leading, spacing: 1) {
                    Text("Unknown").font(Typo.label).foregroundStyle(Ink.muted)
                    if let g = f.group, g.items.count > 1 {
                      Button("in \(g.items.count) photos · show") { nav.go(.person(g.key)) }.buttonStyle(TextLink()).font(Typo.small)
                    }
                  }
                  Spacer()
                  Button("Add Name") { naming = f }.buttonStyle(SecondaryButton())
                }
              }
            }
            if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
          }
          Divider()
        }
        row("Name", item.name)
        row("Taken", item.date.formatted(date: .complete, time: .shortened))
        if let w = item.meta?.width, let h = item.meta?.height { row("Size", "\(Int(exactly: w.rounded(.towardZero)) ?? 0) × \(Int(exactly: h.rounded(.towardZero)) ?? 0) · \(bytes(item.size))") } else { row("Size", bytes(item.size)) }
        if let d = item.meta?.duration { row("Length", Duration.seconds(d).formatted(.time(pattern: .minuteSecond))) }
        if let m = [item.meta?.make, item.meta?.model].compactMap({ $0 }).joined(separator: " ").nilIfEmpty { row("Camera", cameraName(m)) }
        if let g = item.meta?.gps { place(g) }
        row("Type", item.meta?.mime ?? item.kind.rawValue)
        if item.isEditedPicture { row("Edited", "Turned or cropped in another app. The original is kept as it was: Save Original and the export folder save it as taken.") }
        let albums = model.albums.filter { $0.itemIds.contains(item.id) }
        if !albums.isEmpty { row("Albums", albums.map(\.name).joined(separator: ", ")) }
        Label("Encrypted on your devices", systemImage: "lock.fill").font(Typo.caption).foregroundStyle(Ink.teal).padding(.top, 4)
      }
      .padding(.horizontal, 20).padding(.bottom, 20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(Ink.ink)
    .background(Ink.card)
    .task(id: item.id + "\(model.search.version)") { faces = await model.search.facesIn(item.id) }
    .task(id: "\(item.id) \(item.meta?.gps?.lat ?? 0) \(item.meta?.gps?.lon ?? 0)") { // also after the place was changed elsewhere
      placeName = nil
      if let g = item.location { placeName = await PlaceBook.label(g) }
    }
    .sheet(item: $naming) { f in
      NameSheet(title: f.group?.person?.name.isEmpty == false ? "Rename" : "Who is this?", placeholder: "Name", action: "Save", initial: f.group?.person?.name ?? "") { n in
        Task {
          do { try await model.search.name(face: f, n); error = nil; faces = await model.search.facesIn(item.id) }
          catch { self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
        }
      }
    }
  }

  /** "Minato City, Japan" over the coordinates, and the spot on a small map (only while this panel is open, so the
   *  base map's server learns the area of just the photos whose details someone looks at). */
  @ViewBuilder private func place(_ g: GPS) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("Place").font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.muted)
      if let placeName { Text(placeName).font(Typo.body).textSelection(.enabled) }
      Text(String(format: "%.5f, %.5f", g.lat, g.lon)).font(placeName == nil ? Typo.body : Typo.caption)
        .foregroundStyle(placeName == nil ? Ink.ink : Ink.muted).textSelection(.enabled)
      // only once the person turned the map on (its images come from a third party)
      if model.mapOn, let at = item.location, let styles = model.me?.map, model.me?.hasMap == true {
        MiniMap(at: at, styles: styles).padding(.top, 6)
      } else if model.me?.hasMap == true {
        // the map is off on this Mac: the way to it (the question about it comes first)
        Button("Show on the map") { nav.go(.map) }.buttonStyle(TextLink()).padding(.top, 4)
      }
    }
  }

  /** "OPPO OPPO Find X9 Pro" reads better as "OPPO Find X9 Pro". */
  private func cameraName(_ s: String) -> String {
    let parts = s.split(separator: " ")
    if parts.count > 1, parts[1].lowercased().hasPrefix(parts[0].lowercased()) { return parts.dropFirst().joined(separator: " ") }
    return s
  }

  private func row(_ k: String, _ v: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(k).font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.muted)
      Text(v).font(Typo.body).textSelection(.enabled)
    }
  }
}

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }
