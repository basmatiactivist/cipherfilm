// Albums (square covers, serif names) and people (round faces, names): naming, merging, hiding, taking photos out.
import CipherfilmCore
import SwiftUI

struct AlbumsView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @State private var creating = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .bottom) {
        PageTitle(title: "Albums", subtitle: model.albums.isEmpty ? nil : "\(model.albums.count) album\(model.albums.count == 1 ? "" : "s")")
        Button("New Album…") { creating = true }.buttonStyle(SecondaryButton()).padding(.trailing, 28)
      }
      if model.albums.isEmpty {
        Spacer(); EmptyState(icon: "rectangle.stack", title: "No albums yet", text: "Create an album, then right-click photos or drag them onto it."); Spacer()
      } else {
        ScrollView {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 20)], spacing: 22) {
            ForEach(model.albums) { a in
              Button { nav.go(.album(a.id)) } label: { AlbumCover(album: a) }.buttonStyle(TileButton())
                .dropDestination(for: String.self) { ids, _ in model.perform { try await $0.addToAlbum(a.id, ids) }; return true }
            }
          }
          .padding(.horizontal, 28).padding(.vertical, 12)
        }
      }
    }
    .sheet(isPresented: $creating) { NameSheet(title: "New album", placeholder: "Album name", action: "Create") { n in model.perform { _ = try await $0.createAlbum(n) } } }
  }
}

struct AlbumCover: View {
  @Environment(AppModel.self) private var model
  let album: Album
  @State private var image: NSImage?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        Rectangle().fill(Ink.paperDeep)
        if let image { Image(nsImage: image).resizable().aspectRatio(contentMode: .fill) } else { Image(systemName: "rectangle.stack").font(.system(size: 28)).foregroundStyle(Ink.faint) }
      }
      .aspectRatio(1, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: Radius.card))
      Text(album.name).font(Typo.name).foregroundStyle(album.broken ? Ink.danger : Ink.ink).lineLimit(1)
      Text("\(album.itemIds.count) item\(album.itemIds.count == 1 ? "" : "s")").font(Typo.caption).foregroundStyle(Ink.muted)
    }
    .task(id: album.itemIds.last) {
      guard let v = model.vault, let id = album.itemIds.last, let it = model.item(id) else { return }
      image = await model.images.thumb(it, v)
    }
  }
}

struct AlbumView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let id: String
  @Bindable var selection: Selection
  @State private var renaming = false
  @State private var deleting = false

  var body: some View {
    let album = model.albums.first { $0.id == id }
    let items = (album?.itemIds ?? []).compactMap { model.item($0) }.sorted { $0.when > $1.when }
    VStack(spacing: 0) {
      HStack(alignment: .bottom) {
        PageTitle(title: album?.name ?? "Album", subtitle: "\(items.count) item\(items.count == 1 ? "" : "s")")
        Button(selection.ids.count == items.count && !items.isEmpty ? "Select None" : "Select All") {
          if selection.ids.count == items.count { selection.clear() } else { selection.ids = Set(items.map(\.id)) }
        }.buttonStyle(SecondaryButton())
        Menu {
          Button("Rename…") { renaming = true }
          Button("Delete Album…", role: .destructive) { deleting = true }
        } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize().padding(.trailing, 28)
      }
      if items.isEmpty {
        Spacer(); EmptyState(icon: "rectangle.stack", title: "This album is empty", text: "Right-click photos and choose Add to Album, or drag them here."); Spacer()
      } else {
        PhotoGrid(items: items, albumId: id, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
      }
    }
    .sheet(isPresented: $renaming) {
      NameSheet(title: "Rename album", placeholder: "Album name", action: "Rename", initial: album?.name ?? "") { n in model.perform { _ = try await $0.renameAlbum(id, n) } }
    }
    .alert("Delete this album?", isPresented: $deleting) {
      Button("Delete Album", role: .destructive) { model.perform { try await $0.deleteAlbum(id) }; nav.go(.albums) }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Its photos stay in your library.") }
  }
}

// ---- people ----

struct FaceImage: View {
  @Environment(AppModel.self) private var model
  let cover: FaceGroup.Cover?
  var size: CGFloat = 96
  @State private var image: NSImage?

  var body: some View {
    ZStack {
      Circle().fill(Ink.paperDeep)
      if let image { Image(nsImage: image).resizable().aspectRatio(contentMode: .fill) } else { Image(systemName: "person.fill").font(.system(size: size * 0.35)).foregroundStyle(Ink.faint) }
    }
    .frame(width: size, height: size).clipShape(Circle())
    .task(id: cover?.key) {
      guard let c = cover, let v = model.vault, let it = model.item(c.item) else { return }
      image = await model.images.face(c, item: it, v)
    }
  }
}

struct FaceChip: View {
  let group: SearchEngine.Group
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        FaceImage(cover: group.cover, size: 64)
        Text(group.name.isEmpty ? "Name" : group.name).font(Typo.caption.weight(.semibold)).foregroundStyle(group.name.isEmpty ? Ink.teal : Ink.ink).lineLimit(1)
      }.frame(width: 84)
    }.buttonStyle(TileButton())
  }
}

struct PeopleView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Bindable var selection: Selection
  @State private var groups: [SearchEngine.Group]?
  @State private var showHidden = false

  var body: some View {
    let visible = (groups ?? []).filter { $0.person?.hidden != true }
    let hidden = (groups ?? []).filter { $0.person?.hidden == true }
    VStack(spacing: 0) {
      HStack(alignment: .bottom) {
        PageTitle(title: "People", subtitle: groups == nil ? "Grouping faces…" : "Faces are grouped on this Mac. Names are encrypted.")
        if !hidden.isEmpty { Toggle("Show hidden (\(hidden.count))", isOn: $showHidden).toggleStyle(.switch).controlSize(.small).padding(.trailing, 28) }
      }
      if let groups, groups.isEmpty {
        Spacer()
        EmptyState(icon: "person.2", title: model.search.phase == .indexing || model.search.phase == .download ? "Looking at your photos" : "No people yet",
                   text: "Someone shows up here once they are in three photos.")
        Spacer()
      } else {
        ScrollView {
          let named = visible.filter { !$0.name.isEmpty }, unnamed = visible.filter { $0.name.isEmpty }
          VStack(alignment: .leading, spacing: 18) {
            grid(named)
            if !unnamed.isEmpty { Text("Not named yet").font(Typo.heading).padding(.top, 6); grid(unnamed) }
            if showHidden { Text("Hidden").font(Typo.heading).padding(.top, 6); grid(hidden) }
          }
          .padding(.horizontal, 28).padding(.vertical, 12)
        }
      }
    }
    .task(id: model.search.version) { groups = await model.search.peopleGroups() }
  }

  private func grid(_ list: [SearchEngine.Group]) -> some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 18)], alignment: .leading, spacing: 20) {
      ForEach(list) { g in
        Button { nav.go(.person(g.key)) } label: {
          VStack(spacing: 8) {
            FaceImage(cover: g.cover, size: 112)
            Text(g.name.isEmpty ? "Add a name" : g.name).font(g.name.isEmpty ? Typo.label : Typo.name).foregroundStyle(g.name.isEmpty ? Ink.teal : Ink.ink).lineLimit(1)
            Text("\(g.items.count) photo\(g.items.count == 1 ? "" : "s")").font(Typo.small).foregroundStyle(Ink.muted)
          }.frame(width: 130)
        }.buttonStyle(TileButton())
      }
    }
  }
}

struct PersonView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let key: String
  @Bindable var selection: Selection
  @State private var groups: [SearchEngine.Group] = []
  @State private var naming = false
  @State private var error: String?
  @State private var pickedFaces = Set<String>()
  @State private var hoverFace: String?
  @State private var newPersonFor: [String]?

  var body: some View {
    let g = groups.first { $0.key == key }
    let items = (g?.items ?? []).compactMap { model.item($0) }.sorted { $0.when > $1.when }
    VStack(spacing: 0) {
      HStack(alignment: .center, spacing: 16) {
        FaceImage(cover: g?.cover, size: 72)
        VStack(alignment: .leading, spacing: 4) {
          Text(g?.name.isEmpty == false ? g!.name : "Not named yet").font(Typo.page)
          Text("\(items.count) photo\(items.count == 1 ? "" : "s")" + (g?.person?.hidden == true ? " · hidden" : "")).font(Typo.body).foregroundStyle(Ink.muted)
        }
        Spacer()
        if let g {
          Button(selection.ids.count == items.count && !items.isEmpty ? "Select None" : "Select All \(items.count)") {
            if selection.ids.count == items.count { selection.clear() } else { selection.ids = Set(items.map(\.id)) }
          }.buttonStyle(SecondaryButton()).help("Select every photo of this person")
          Button(g.name.isEmpty ? "Add a Name…" : "Rename…") { naming = true }.buttonStyle(PrimaryButton())
          Menu {
            let others = model.search.people.people.filter { !$0.name.isEmpty && $0.id != g.person?.id }
            if !others.isEmpty {
              Menu("Same Person As") { ForEach(others) { p in Button(p.name) { act { try await model.search.merge(g, into: p) }; nav.go(.people) } } }
            }
            if g.person != nil, !selection.ids.isEmpty {
              Button("Not \(g.name.isEmpty ? "this person" : g.name) (\(selection.ids.count) selected)") { let s = selection.ids; act { try await model.search.remove(items: s, from: g) }; selection.clear() }
            }
            Button(g.person?.hidden == true ? "Show in People" : "Hide from People") { act { try await model.search.setHidden(g, !(g.person?.hidden ?? false)) } }
            if let p = g.person, !p.name.isEmpty { Divider(); Button("Forget Name") { act { try await model.search.forget(p) }; nav.go(.people) } }
          } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
        }
      }
      .padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 10)
      if let error { Note(text: error).padding(.horizontal, 28) }
      if let g { faceStrip(g) }
      if g?.person != nil { Text("Select photos that aren't this person, then choose Not \(g!.name.isEmpty ? "this person" : g!.name) from the menu.").font(Typo.caption).foregroundStyle(Ink.faint).padding(.horizontal, 28).frame(maxWidth: .infinity, alignment: .leading) }
      PhotoGrid(items: items, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
    }
    .task(id: model.search.version) { groups = await model.search.peopleGroups() }
    .sheet(isPresented: $naming) {
      NameSheet(title: g?.name.isEmpty == false ? "Rename" : "Who is this?", placeholder: "Name", action: "Save", initial: g?.name ?? "") { n in
        guard let g else { return }
        Task {
          do {
            if let id = try await model.search.name(g, n), id != key { nav.screen = .person(id) }
            error = nil
          } catch {
            self.error = "Couldn't save the name: " + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
          }
        }
      }
    }
  }

  /** The faces themselves: click to pick, drag onto another person (or use Move to) to give them to someone else. */
  @ViewBuilder private func faceStrip(_ g: SearchEngine.Group) -> some View {
    let faces = model.search.faces(of: g)
    let others = groups.filter { $0.key != g.key && $0.person?.name.isEmpty == false && $0.person?.hidden != true }
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Faces").font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.muted)
        Text(pickedFaces.isEmpty ? "Click to pick, drag onto a person to move" : "\(pickedFaces.count) picked").font(Typo.small).foregroundStyle(Ink.faint)
        Spacer()
        if !pickedFaces.isEmpty {
          Menu("Move to") {
            ForEach(others) { o in Button(o.name) { moveFaces(Array(pickedFaces), from: g, to: o.person) } }
            Divider()
            Button("New Person…") { newPersonFor = Array(pickedFaces) }
          }.fixedSize()
          Button("Clear") { pickedFaces = [] }.buttonStyle(TextLink()).font(Typo.caption)
        }
      }
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 8) {
          ForEach(faces, id: \.key) { f in
            FaceImage(cover: f, size: 56)
              .overlay(Circle().strokeBorder(pickedFaces.contains(f.key) ? Ink.teal : hoverFace == f.key ? Ink.ruleStrong : .clear, lineWidth: 3))
              .onHover { hoverFace = $0 ? f.key : (hoverFace == f.key ? nil : hoverFace) }
              .onTapGesture { if pickedFaces.contains(f.key) { pickedFaces.remove(f.key) } else { pickedFaces.insert(f.key) } }
              .accessibilityElement(children: .ignore)
              .accessibilityLabel("Face")
              .accessibilityAddTraits(pickedFaces.contains(f.key) ? [.isButton, .isSelected] : .isButton)
              .accessibilityAction { if pickedFaces.contains(f.key) { pickedFaces.remove(f.key) } else { pickedFaces.insert(f.key) } }
              .onDrag {
                let keys = pickedFaces.contains(f.key) ? Array(pickedFaces) : [f.key]
                return NSItemProvider(object: ("faces:" + keys.joined(separator: ",")) as NSString)
              }
          }
        }.padding(.vertical, 2)
      }.frame(height: 62)
      if !others.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 10) {
            Text("Drop on:").font(Typo.small).foregroundStyle(Ink.faint)
            ForEach(others) { o in
              HStack(spacing: 6) { FaceImage(cover: o.cover, size: 24); Text(o.name).font(Typo.caption.weight(.semibold)) }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Capsule().fill(Ink.paperDeep))
                .dropDestination(for: String.self) { vals, _ in
                  let keys = vals.filter { $0.hasPrefix("faces:") }.flatMap { $0.dropFirst(6).split(separator: ",").map(String.init) }
                  guard !keys.isEmpty else { return false }
                  moveFaces(keys, from: g, to: o.person); return true
                }
            }
          }
        }
      }
    }
    .padding(.horizontal, 28).padding(.bottom, 8)
    .sheet(isPresented: Binding(get: { newPersonFor != nil }, set: { if !$0 { newPersonFor = nil } })) {
      NameSheet(title: "New person", placeholder: "Name", action: "Create") { n in
        let keys = newPersonFor ?? []
        act { try await model.search.move(faces: keys, from: g, to: nil, newName: n) }
        pickedFaces = []
      }
    }
  }

  private func moveFaces(_ keys: [String], from g: SearchEngine.Group, to p: Person?) {
    guard let p else { return }
    act { try await model.search.move(faces: keys, from: g, to: p) }
    pickedFaces = []
  }

  private func act(_ f: @escaping () async throws -> Void) {
    Task { do { try await f(); error = nil } catch { self.error = error.localizedDescription } }
  }
}
