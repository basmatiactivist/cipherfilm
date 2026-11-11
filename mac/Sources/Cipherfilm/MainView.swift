// The unlocked window: a paper sidebar (Photos, Favorites, Videos, People, Albums, Map, Trash), the screen, one search box,
// Upload, and a drop veil for files dragged in from the Finder.
import CipherfilmCore
import UniformTypeIdentifiers
import SwiftUI

enum Screen: Hashable {
  case photos, favorites, videos, people, albums, map, trash
  case album(String)
  case person(String)
  case similar(String)
}

@MainActor @Observable
final class Navigator {
  var screen: Screen = .photos
  var query = ""
  var viewer: ViewerState?
  var confirmPurge: [String]?
  var newAlbumFor: [String]?
  var albumPickFor: [String]?
  var back: [Screen] = []
  /** "Go to date": the grid scrolls to the newest day on or before it */
  var jump: Date?
  var jumpPicker = false

  func go(_ s: Screen) {
    if s != screen { back.append(screen) }
    screen = s; viewer = nil
  }

  func showSimilar(_ id: String) { query = ""; go(.similar(id)) }
}

struct ViewerState: Equatable {
  var ids: [String]
  var index: Int
  var id: String { ids[index] }
}

struct MainView: View {
  @Environment(AppModel.self) private var model
  @State private var nav = Navigator()
  @State private var selection = Selection()
  @State private var dropping = false

  var body: some View {
    NavigationSplitView {
      Sidebar(nav: nav)
        .navigationSplitViewColumnWidth(min: 200, ideal: 232, max: 300)
    } detail: {
      ZStack {
        Ink.paper.ignoresSafeArea()
        Detail(nav: nav, selection: selection)
      }
      .overlay(alignment: .top) { NoticeBanner() }
      .toolbar { toolbar }
      .searchable(text: $nav.query, placement: .toolbar, prompt: model.search.ready ? "Search: beach, Anna, 2023, videos…" : "Search by name, date or camera")
    }
    .environment(nav)
    // the viewer takes the whole window: no toolbar, no sidebar, black up to the title bar
    .toolbar(nav.viewer == nil ? .visible : .hidden, for: .windowToolbar)
    .overlay { if let v = nav.viewer { Viewer(state: v).environment(nav).ignoresSafeArea().transition(.opacity) } }
    .overlay { if dropping { DropVeil() } }
    .onDrop(of: [.fileURL, .image, .movie], isTargeted: $dropping) { providers in Dropper.take(providers, model); return !providers.isEmpty }
    .onChange(of: nav.screen) { selection.clear() }
    .onChange(of: nav.query) { selection.clear() }
    .alert("Delete forever?", isPresented: Binding(get: { nav.confirmPurge != nil }, set: { if !$0 { nav.confirmPurge = nil } })) {
      Button("Delete Forever", role: .destructive) { if let ids = nav.confirmPurge { model.purge(ids); selection.clear() } }
      Button("Cancel", role: .cancel) {}
    } message: { Text("This can't be undone.") }
    .sheet(isPresented: Binding(get: { nav.newAlbumFor != nil }, set: { if !$0 { nav.newAlbumFor = nil } })) {
      NameSheet(title: "New album", placeholder: "Album name", action: "Create") { name in
        let ids = nav.newAlbumFor ?? []
        model.perform { v in let a = try await v.createAlbum(name); if !ids.isEmpty { try await v.addToAlbum(a.id, ids) } }
      }
    }
    .sheet(isPresented: Binding(get: { nav.albumPickFor != nil }, set: { if !$0 { nav.albumPickFor = nil } })) {
      AlbumPickSheet(ids: nav.albumPickFor ?? []).environment(nav)
    }
    .task { if model.trash.isEmpty { await model.loadTrash() } }
    .onAppear { model.nav = nav; model.selection = selection }
    #if DEBUG
    .onAppear {
      let h = DebugHooks.shared, n = nav
      h.open = { id in n.viewer = ViewerState(ids: [id], index: 0) }
      h.close = { n.viewer = nil }
      h.go = { n.query = ""; n.go($0) }
      h.query = { n.query = $0 }
      h.jump = { n.jump = $0 }
    }
    #endif
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItemGroup(placement: .primaryAction) {
      if !selection.ids.isEmpty {
        Text("\(selection.ids.count) selected").font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.muted)
        Menu { ItemMenu(ids: Array(selection.ids), trashMode: nav.screen == .trash, albumId: { if case .album(let a) = nav.screen { return a }; return nil }()) } label: {
          Label("Actions", systemImage: "ellipsis.circle")
        }
        Button { selection.clear() } label: { Label("Clear selection", systemImage: "xmark") }
      }
      Button { nav.jumpPicker = true } label: { Label("Go to Date", systemImage: "calendar") }
        .help("Go to a date (⌘J)").keyboardShortcut("j", modifiers: .command)
        .popover(isPresented: $nav.jumpPicker) { JumpPicker(nav: nav) }
      if model.me?.isDemo != true {
        Button { UploadPicker.pick(model) } label: { Label("Upload", systemImage: "icloud.and.arrow.up").labelStyle(.titleAndIcon) }
          .help("Upload photos and videos, or drop them on the window")
      }
      Button { model.lock() } label: { Label("Lock", systemImage: "lock") }.help("Lock the library")
    }
  }
}

/** "Add to Album…" from the Photo menu (⌃⌘A): pick an album, or make a new one. */
struct AlbumPickSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Environment(\.dismiss) private var dismiss
  let ids: [String]
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(ids.count == 1 ? "Add to album" : "Add \(ids.count) items to album").font(Typo.dialog)
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(model.albums.filter { !$0.broken }) { a in
            Button { model.perform { try await $0.addToAlbum(a.id, ids) }; dismiss() } label: {
              HStack { Image(systemName: "rectangle.stack").foregroundStyle(Ink.teal); Text(a.name).font(Typo.name); Spacer(); Text("\(a.itemIds.count)").foregroundStyle(Ink.muted) }
                .padding(.horizontal, 10).frame(height: 34)
            }.buttonStyle(SidebarRow())
          }
        }
      }.frame(maxHeight: 320)
      HStack {
        Button("New Album…") { let i = ids; dismiss(); DispatchQueue.main.async { nav.newAlbumFor = i } }.buttonStyle(SecondaryButton())
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction)
      }
    }
    .padding(22).frame(width: 380).background(Ink.card)
  }
}

struct JumpPicker: View {
  @Bindable var nav: Navigator
  @State private var date = Date()
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Go to date").font(Typo.heading)
      DatePicker("", selection: $date, displayedComponents: .date).datePickerStyle(.graphical).labelsHidden()
      HStack {
        Spacer()
        Button("Go") {
          if case .photos = nav.screen {} else if nav.screen != .favorites && nav.screen != .videos { nav.go(.photos) }
          nav.query = ""; nav.jump = date; nav.jumpPicker = false
        }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
      }
    }.padding(16).frame(width: 260)
  }
}

/** Whatever is dropped on the window: files and folders from the Finder, and photos and videos from apps that only
 *  promise a file (Photos, browsers). Promised files are written into the app's inbox, then queued. */
enum Dropper {
  @MainActor static func take(_ providers: [NSItemProvider], _ model: AppModel) {
    for p in providers {
      if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        _ = p.loadObject(ofClass: URL.self) { url, _ in
          guard let url else { return }
          let kept = AppModel.Inbox.keep(url)
          Task { @MainActor in model.upload([kept]) }
        }
      } else if let type = [UTType.movie, .image].first(where: { t in p.registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: t) == true } }),
                let id = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: type) == true }) {
        p.loadFileRepresentation(forTypeIdentifier: id) { url, _ in
          guard let url else { return }
          // the file exists only inside this callback: copied now
          let kept = AppModel.Inbox.keep(url)
          Task { @MainActor in model.upload([kept]) }
        }
      }
    }
  }
}

struct DropVeil: View {
  var body: some View {
    ZStack {
      Ink.tealTint.opacity(0.85)
      VStack(spacing: 10) {
        Image(systemName: "icloud.and.arrow.up").font(.system(size: 34)).foregroundStyle(Ink.teal)
        Text("Drop to encrypt and upload").font(Typo.dialog).foregroundStyle(Ink.tealInk)
      }
    }
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.teal, style: StrokeStyle(lineWidth: 3, dash: [8, 6])).padding(12))
    .allowsHitTesting(false)
  }
}

// ---- sidebar ----

struct Sidebar: View {
  @Environment(AppModel.self) private var model
  @Bindable var nav: Navigator

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) { Mark(size: 22); Text("Cipherfilm").font(Typo.brand); Spacer() }
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 4)
      HStack(spacing: 5) {
        Image(systemName: "server.rack").font(Typo.micro)
        Text(model.serverName).lineLimit(1).truncationMode(.middle)
        Spacer()
      }
      .font(Typo.small).foregroundStyle(Ink.muted)
      .padding(.horizontal, 18).padding(.bottom, 12)
      .help("\(model.me?.user.email ?? "") on \(model.serverName)")
      if model.me?.isDemo == true {
        Text(Me.demoNote).font(Typo.small.weight(.semibold)).foregroundStyle(Ink.teal)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 18).padding(.bottom, 12)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          NavItem(title: "Photos", icon: "photo.on.rectangle", screen: .photos, nav: nav)
          NavItem(title: "Favorites", icon: "heart", screen: .favorites, nav: nav)
          NavItem(title: "Videos", icon: "film", screen: .videos, nav: nav)
          if model.settings.search && model.settings.faces { NavItem(title: "People", icon: "person.2", screen: .people, nav: nav) }
          NavItem(title: "Albums", icon: "rectangle.stack", screen: .albums, nav: nav)
          ForEach(model.albums.prefix(12)) { a in
            NavItem(title: a.name, icon: nil, screen: .album(a.id), nav: nav, indent: true)
          }
          // the server sends the base map's styles; none when its operator turned the map off
          if model.me?.hasMap == true { NavItem(title: "Map", icon: "map", screen: .map, nav: nav) }
          NavItem(title: "Trash", icon: "trash", screen: .trash, nav: nav)
        }
        .padding(.horizontal, 10)
      }
      Spacer(minLength: 0)
      SettingsLink {
        HStack(spacing: 10) {
          Image(systemName: "gearshape").font(.system(size: 15)).frame(width: 22)
          Text("Settings").font(Typo.label)
          Spacer()
          Text("⌘,").font(Typo.small).foregroundStyle(Ink.faint)
        }
        .padding(.horizontal, 10).frame(height: 36)
      }
      .buttonStyle(SidebarRow())
      .padding(.horizontal, 10)
      StatusCard()
        .padding(12)
    }
    .background(Ink.paper)
  }
}

struct NavItem: View {
  let title: String
  let icon: String?
  let screen: Screen
  @Bindable var nav: Navigator
  var indent = false

  var body: some View {
    let current = nav.screen == screen && nav.query.isEmpty
    Button { nav.query = ""; nav.go(screen) } label: {
      HStack(spacing: 10) {
        if let icon { Image(systemName: icon).font(.system(size: 15)).frame(width: 22) } else { Color.clear.frame(width: 22) }
        Text(title).font(indent ? Typo.name : Typo.label).lineLimit(1)
        Spacer()
      }
      .padding(.horizontal, 10).frame(height: indent ? 30 : 36)
    }
    .buttonStyle(SidebarRow(current: current))
  }
}

/** What runs in the background, at the bottom of the sidebar: uploads, export, watched folders, search. */
struct StatusCard: View {
  @Environment(AppModel.self) private var model
  @State private var showUploads = false
  @State private var consent: ModelConsentAsk?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      let failed = model.uploads.filter { if case .failed = $0.state { return true }; return false }.count
      if let u = model.uploadProgress {
        Button { showUploads = true } label: {
          StatusLine(icon: model.uploadsPaused ? "pause.circle" : "arrow.up.circle", text: (model.uploadsPaused ? "Paused · " : "Uploading ") + "\(min(u.done + 1, u.total)) of \(u.total)" + (failed > 0 ? " · \(failed) failed" : ""), fraction: u.fraction)
        }.buttonStyle(TileButton(radius: 6)).help("Show uploads")
      } else if failed > 0 {
        Button { showUploads = true } label: { StatusLine(icon: "exclamationmark.triangle", text: "\(failed) upload\(failed == 1 ? "" : "s") failed", problem: true) }.buttonStyle(TileButton(radius: 6)).help("Show uploads")
      }
      if model.settings.exportOn {
        let e = model.exporter
        StatusLine(icon: "folder", text: e.phase == .working ? "Exporting \(e.done) of \(e.total)" : e.phase == .error ? (e.message ?? "Export stopped") : "Export folder up to date",
                   fraction: e.phase == .working && e.total > 0 ? Double(e.done) / Double(e.total) : nil, problem: e.phase == .error)
      }
      if model.settings.watchOn {
        let w = model.watcher
        StatusLine(icon: "eye", text: w.problem ?? (w.running ? (w.current.map { "Uploading \($0)" + (w.waiting > 1 ? " · \(w.waiting - 1) more waiting" : "") } ?? "Checking watched folders") : "Watching \(model.settings.watched.count) folder\(model.settings.watched.count == 1 ? "" : "s") · \(w.uploaded) uploaded"), problem: w.problem != nil)
      }
      if model.settings.search {
        let s = model.search
        switch s.phase {
        case .consent:
          Button { consent = s.pendingAsk() } label: { StatusLine(icon: "arrow.down.circle", text: "Search waits for your OK to download the models") }
            .buttonStyle(TileButton(radius: 6)).help("See what is downloaded")
        case .download: StatusLine(icon: "arrow.down.circle", text: s.downloadText, fraction: s.total > 0 ? Double(s.done) / Double(s.total) : nil)
        case .loading: StatusLine(icon: "sparkle.magnifyingglass", text: "Starting search")
        case .indexing: StatusLine(icon: "sparkle.magnifyingglass", text: "Indexing \(s.done) of \(s.total)", fraction: s.total > 0 ? Double(s.done) / Double(s.total) : nil)
        case .waitPower: StatusLine(icon: "powerplug", text: s.message ?? "Waiting for power")
        case .error: StatusLine(icon: "exclamationmark.triangle", text: s.message ?? "Search stopped", problem: true)
        case .ready, .off: EmptyView()
        }
      }
      HStack(spacing: 8) {
        Image(systemName: "lock.fill").font(Typo.caption).foregroundStyle(Ink.teal)
        VStack(alignment: .leading, spacing: 1) {
          Text("Private to you").font(Typo.caption.weight(.semibold))
          Text("\(model.items.count) items").font(Typo.small).foregroundStyle(Ink.muted)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
    .popover(isPresented: $showUploads, arrowEdge: .trailing) { UploadsPanel().environment(model) }
    .sheet(item: $consent) { a in ModelConsentSheet(ask: a, yes: { consent = nil; model.search.agree(a) }, later: { consent = nil }) }
  }
}

/** Every upload of this session and the saved queue: progress, what failed and why, retry, pause. */
struct UploadsPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Uploads").font(Typo.heading)
        Spacer()
        Button(model.uploadsPaused ? "Resume" : "Pause") { model.uploadsPaused.toggle() }.buttonStyle(SecondaryButton())
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(model.uploads) { j in
            HStack(spacing: 10) {
              Image(systemName: icon(j.state)).foregroundStyle(color(j.state)).frame(width: 16)
              VStack(alignment: .leading, spacing: 3) {
                Text(j.name).font(Typo.caption.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                switch j.state {
                case .running: ProgressView(value: Double(j.done), total: Double(max(1, j.total))).controlSize(.small)
                case .failed(let m): Text(m).font(Typo.small).foregroundStyle(Ink.danger).lineLimit(2)
                case .waiting: Text(model.uploadsPaused ? "Paused" : "Waiting").font(Typo.small).foregroundStyle(Ink.muted)
                case .done: Text("Uploaded").font(Typo.small).foregroundStyle(Ink.ok)
                }
              }
              Spacer()
              if case .failed = j.state { Button("Retry") { model.retry(j.id) }.buttonStyle(TextLink()).font(Typo.caption) }
              if j.state == .waiting || { if case .failed = j.state { return true }; return false }() {
                Button { model.cancelUpload(j.id) } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Remove from the queue").accessibilityLabel("Remove \(j.name) from the queue")
              }
            }
          }
        }
      }.frame(minHeight: 120, maxHeight: 360)
      HStack {
        Button("Retry Failed") { model.retry() }.disabled(!model.uploads.contains { if case .failed = $0.state { return true }; return false })
        Spacer()
        Button("Clear Finished") { model.clearFinishedUploads() }
      }.font(Typo.caption)
      Text("The queue survives a restart or lock and continues once you unlock.").font(Typo.small).foregroundStyle(Ink.faint)
    }
    .padding(16).frame(width: 380)
    .background(Ink.card)
  }

  private func icon(_ s: UploadJob.State) -> String {
    switch s { case .waiting: "clock"; case .running: "arrow.up.circle"; case .done: "checkmark.circle.fill"; case .failed: "exclamationmark.triangle.fill" }
  }
  private func color(_ s: UploadJob.State) -> Color {
    switch s { case .waiting: Ink.faint; case .running: Ink.teal; case .done: Ink.ok; case .failed: Ink.danger }
  }
}

struct StatusLine: View {
  let icon: String
  let text: String
  var fraction: Double?
  var problem = false

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Image(systemName: icon).font(Typo.small).foregroundStyle(problem ? Ink.danger : Ink.teal).frame(width: 14)
        Text(text).font(Typo.small).foregroundStyle(problem ? Ink.danger : Ink.muted).lineLimit(2)
      }
      if let fraction {
        GeometryReader { g in
          ZStack(alignment: .leading) {
            Capsule().fill(Ink.paperDeep)
            Capsule().fill(Ink.teal).frame(width: max(4, g.size.width * min(1, fraction)))
          }
        }.frame(height: 5)
      }
    }
  }
}

// ---- the screens ----

struct PageTitle: View {
  let title: String
  var subtitle: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(Typo.page).foregroundStyle(Ink.ink)
      if let subtitle { Text(subtitle).font(Typo.body).foregroundStyle(Ink.muted) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 6)
  }
}

struct Detail: View {
  @Environment(AppModel.self) private var model
  @Bindable var nav: Navigator
  @Bindable var selection: Selection

  var body: some View {
    VStack(spacing: 0) {
      if let e = model.loadError {
        Note(text: e, close: { model.loadError = nil }).padding(.horizontal, 28).padding(.top, 10)
      }
      if !nav.query.trimmingCharacters(in: .whitespaces).isEmpty {
        SearchResults(query: nav.query, selection: selection)
      } else {
        switch nav.screen {
        case .photos: library(title: "Photos", items: model.items, empty: ("photo.on.rectangle", "Nothing here yet", "Drop photos and videos here, or choose Upload. They are encrypted on this Mac before upload."))
        case .favorites: library(title: "Favorites", items: model.items.filter(\.favorite), empty: ("heart", "No favorites yet", "Right-click a photo and choose Add to Favorites, or click the heart in the viewer."))
        case .videos: library(title: "Videos", items: model.items.filter { $0.kind == .video }, empty: ("film", "No videos", "Videos you upload show up here."))
        case .people: PeopleView(selection: selection)
        case .person(let key): PersonView(key: key, selection: selection)
        case .albums: AlbumsView()
        case .album(let id): AlbumView(id: id, selection: selection)
        case .map: if model.me?.hasMap == true { MapTab(selection: selection) } else { Spacer(); EmptyState(icon: "map", title: "The map is turned off", text: "This server doesn't offer a map."); Spacer() }
        case .trash: TrashView(selection: selection)
        case .similar(let id): SimilarView(id: id, selection: selection)
        }
      }
    }
  }

  @ViewBuilder private func library(title: String, items: [Item], empty: (String, String, String)) -> some View {
    PageTitle(title: title, subtitle: items.isEmpty ? nil : "\(items.count) item\(items.count == 1 ? "" : "s")")
    if items.isEmpty && model.loading {
      Loading(label: "Opening your library…")
    } else if items.isEmpty {
      Spacer(); EmptyState(icon: empty.0, title: empty.1, text: empty.2); Spacer()
    } else {
      if title == "Photos" { MemoriesRow(items: items) }
      PhotoGrid(items: items, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
    }
  }
}

struct SearchResults: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let query: String
  @Bindable var selection: Selection
  @State private var result: SearchEngine.Result?
  /** how many of the ranked results are shown: a page of 200, then more as the end comes into view */
  @State private var shown = 200

  /** Why nothing was found, and what helps: photos another device hasn't indexed yet are said (docs/SEARCH.md). */
  private var emptyText: String {
    guard model.settings.search else { return "Search covers names, dates and cameras. Turn on search in Settings to find what and who is in your photos." }
    let s = model.search
    if !s.indexes && s.phase == .ready && s.waiting > 0 {
      return "\(s.waiting) \(s.waiting == 1 ? "photo or video isn't" : "photos and videos aren't") indexed yet by the device that indexes your photos. To index them on this Mac instead, go to Settings › Search & People."
    }
    return "Try what is in the photo (“dog on the beach”), a name, a year or a month."
  }

  var body: some View {
    VStack(spacing: 0) {
      PageTitle(title: "Search", subtitle: result.map { r in r.items.isEmpty ? "Nothing found" : (r.ranked ? "Best matches first" : "\(r.items.count) found") + (r.how.isEmpty ? "" : " · " + r.how.joined(separator: " · ")) } ?? "Searching…")
      if let r = result, !r.people.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 14) { ForEach(r.people) { g in FaceChip(group: g) { nav.query = ""; nav.go(.person(g.key)) } } }.padding(.horizontal, 28).padding(.vertical, 6)
        }
      }
      if let r = result {
        if r.items.isEmpty {
          Spacer()
          EmptyState(icon: "magnifyingglass", title: "Nothing found", text: emptyText)
          Spacer()
        } else {
          PhotoGrid(items: Array(r.items.prefix(shown)), grouping: .none, selection: selection,
                    more: r.items.count > shown ? { shown += 200 } : nil) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
        }
      } else {
        Loading(label: "Searching…")
      }
    }
    .task(id: query + "\(model.search.version)\(model.items.count)") {
      try? await Task.sleep(nanoseconds: 180_000_000) // typing
      if Task.isCancelled { return }
      let r = await model.search.search(query, library: model.items)
      if Task.isCancelled { return }
      if result?.how != r.how { shown = 200 } // a new query starts at the top page
      result = r
    }
  }
}

struct SimilarView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let id: String
  @Bindable var selection: Selection

  var body: some View {
    let ids = model.search.similar(to: id)
    let items = ([id] + ids).compactMap { model.item($0) }
    VStack(spacing: 0) {
      PageTitle(title: "Photos like this one", subtitle: ids.isEmpty ? "None found yet" : "\(ids.count) similar")
      PhotoGrid(items: items, grouping: .none, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
    }
  }
}

struct TrashView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Bindable var selection: Selection

  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .bottom) {
        PageTitle(title: "Trash", subtitle: "Items are permanently deleted after \(model.retentionDays) days.")
        if !model.trash.isEmpty {
          Button("Restore All") { model.restore(model.trash.map(\.id)) }.buttonStyle(SecondaryButton())
          Button("Empty Trash…") { nav.confirmPurge = model.trash.map(\.id) }.buttonStyle(SecondaryButton(danger: true)).padding(.trailing, 28)
        }
      }
      if model.trash.isEmpty {
        Spacer(); EmptyState(icon: "trash", title: "The trash is empty", text: "Deleted items stay here for \(model.retentionDays) days and can be restored."); Spacer()
      } else {
        PhotoGrid(items: model.trash, grouping: .none, trashMode: true, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
      }
    }
    .task { await model.loadTrash() }
  }
}

struct NameSheet: View {
  let title: String
  let placeholder: String
  let action: String
  var initial = ""
  let done: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(title).font(Typo.dialog)
      TextField(placeholder, text: $name).field().onSubmit(go)
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction)
        Button(action, action: go).buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .padding(24).frame(width: 380).background(Ink.card)
    .onAppear { name = initial }
  }

  private func go() {
    let n = name.trimmingCharacters(in: .whitespaces)
    guard !n.isEmpty else { return }
    done(n); dismiss()
  }
}
