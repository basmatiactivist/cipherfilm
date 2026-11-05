// Settings: everything the Mac does by itself can be turned on and off here, like search on Android.
import CipherfilmCore
import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    TabView {
      GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }
      SearchSettings().tabItem { Label("Search & People", systemImage: "sparkle.magnifyingglass") }
      ExportSettings().tabItem { Label("Export", systemImage: "folder") }
      WatchSettings().tabItem { Label("Watched Folders", systemImage: "eye") }
    }
    .frame(width: 560)
    .tint(Ink.teal)
  }
}

struct Section_<Content: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder let content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(Typo.title)
      if let subtitle { Text(subtitle).font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
      content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct NeedsUnlock: View {
  var body: some View {
    Label("Unlock your library to change this.", systemImage: "lock").font(Typo.caption).foregroundStyle(.secondary)
  }
}

struct GeneralSettings: View {
  @Environment(AppModel.self) private var model
  @State private var signOut = false
  @State private var touchError: String?

  var body: some View {
    @Bindable var agent = model.agent
    VStack(alignment: .leading, spacing: 22) {
      Section_(title: "This Mac", subtitle: "With the window closed, Cipherfilm stays in the menu bar and keeps exporting, uploading watched folders and looking at photos.") {
        Toggle("Keep running in the menu bar when the window is closed or ⌘Q is pressed", isOn: $agent.keepRunning)
        Text("Quit it from the menu-bar panel (the power button). Logging out or shutting down ends it as usual.").font(Typo.caption).foregroundStyle(.secondary)
        Toggle("Open at login", isOn: Binding(get: { model.agent.openAtLogin }, set: { model.agent.setOpenAtLogin($0) }))
        Toggle("Notify me when uploads, exports and indexing finish", isOn: Binding(get: { Notifier.enabled }, set: { Notifier.enabled = $0 }))
        if let p = model.agent.loginProblem { Text(p).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
      Divider()
      Section_(title: "Unlock with Touch ID", subtitle: "A key in this Mac's Secure Enclave, usable only after your fingerprint, keeps a locked copy of your library's key. Adding a fingerprint turns it off; your password always works.") {
        Toggle("Unlock with Touch ID", isOn: Binding(get: { model.touchID }, set: { on in
          touchError = nil
          if on { Task { do { try await model.enableTouchID() } catch { touchError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription } } }
          else { model.disableTouchID() }
        }))
        .disabled(!TouchID.available || (model.phase != .unlocked && !model.touchID))
        if !TouchID.available { Text("This Mac has no Touch ID, or no fingerprint is set up.").font(Typo.caption).foregroundStyle(.secondary) }
        else if model.phase != .unlocked && !model.touchID { NeedsUnlock() }
        if let touchError { Text(touchError).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
      Divider()
      Section_(title: "Account") {
        if let me = model.me {
          LabeledContent("Signed in as", value: me.user.email)
          if model.server != nil { LabeledContent("Server", value: model.serverName) }
          HStack {
            Button("Lock") { model.lock() }.disabled(model.phase != .unlocked)
            Button("Sign Out…") { signOut = true }
          }
          Text("Signing out deletes everything this Mac keeps for the account. Locking only forgets the keys; watched folders keep uploading.")
            .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } else {
          Text("Not signed in.").foregroundStyle(.secondary)
        }
      }
      Divider()
      Text("Cipherfilm \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") · libsodium \(Sodium.version) · ONNX Runtime \(Vision.runtimeVersion)")
        .font(Typo.small).foregroundStyle(.tertiary)
    }
    .padding(24)
    .sheet(isPresented: $signOut) { SignOutSheet().environment(model) }
  }
}

struct SearchSettings: View {
  @Environment(AppModel.self) private var model
  @State private var confirm = false
  @State private var error: String?
  @State private var explicitAsk: Bool?
  @State private var askModel = false
  @State private var explicitBusy = false
  @State private var indexer: SearchEngine.Device?
  @State private var takingOver = false

  var body: some View {
    @Bindable var model = model
    let unlocked = model.phase == .unlocked
    VStack(alignment: .leading, spacing: 20) {
      Section_(title: "Search what is in photos, and people", subtitle: "Runs on this Mac with open models (MobileCLIP, YuNet, SFace) downloaded once from your own server\(size(.mobileclip).map { ", \($0)" } ?? " (already on this Mac)"). What it finds is encrypted and stored on your server, so your phone and this Mac share it. Nothing is sent anywhere else.") {
        Toggle("Search and people", isOn: Binding(get: { model.settings.search }, set: { on in
          // where explicit search is allowed, which model is asked first, so only that one is downloaded
          if on && model.me?.user.nsfw == true { askModel = true } else { model.settings.search = on; model.settings.searchAsked = true }
        }))
          .disabled(!unlocked)
        Toggle("Find faces and group them into people", isOn: $model.settings.faces).disabled(!unlocked || !model.settings.search)
        Toggle("Also while on battery", isOn: $model.settings.indexOnBattery).disabled(!model.settings.search)
        if !unlocked { NeedsUnlock() }
      }
      // only for a person an admin allowed it (docs/SEARCH.md, "Explicit search")
      if model.me?.user.nsfw == true && model.settings.search {
        let on = model.search.people.explicit == true
        Section_(title: "Explicit search", subtitle: "Uses a second model, LAION's OpenCLIP ViT-B/32, that also understands explicit content (MobileCLIP was trained without it). It is \(size(.laion).map { "a download of \($0)" } ?? "already on this Mac"). The choice is for your account: every photo is looked at again with the other model, and your phone and other devices switch too.") {
          Toggle("Explicit search", isOn: Binding(get: { on }, set: { explicitAsk = $0 }))
            .disabled(!unlocked || explicitBusy || model.search.phase == .off)
          if on && model.search.clip == .laion { Text("On. Searches use the LAION model.").font(Typo.caption).foregroundStyle(.secondary) }
        }
      }
      if model.settings.search {
        let s = model.search
        let c = s.index.count
        Section_(title: "Status") {
          Text(status(s)).font(Typo.caption)
          Text("\(c.items) photos and videos indexed, \(c.faces) faces.").font(Typo.caption).foregroundStyle(.secondary)
        }
        // one device per account looks at the photos; the others read what it found (docs/SEARCH.md)
        Section_(title: "Which device indexes", subtitle: "One of your devices looks at the photos and stores what it finds; the others only read it, and download just the text model to understand your search words.") {
          if s.indexes {
            Text("This Mac indexes your photos.").font(Typo.caption)
          } else {
            Text(indexedBy).font(Typo.caption)
            Button(takingOver ? "Switching…" : "Index on This Mac Instead") {
              takingOver = true
              Task {
                do { if let api = model.api { try await model.search.indexHere(api: api) }; error = nil } catch { self.error = error.localizedDescription }
                takingOver = false
              }
            }
            .disabled(!unlocked || takingOver)
          }
        }
        .task(id: s.indexes) {
          // the device list changes rarely; looked at again while the settings are open
          while !Task.isCancelled {
            if let api = model.api { indexer = await s.indexingDevice(api: api) }
            try? await Task.sleep(nanoseconds: 30_000_000_000)
          }
        }
      }
      Divider()
      Section_(title: "Turn off and delete", subtitle: "Removes the models and the index from this Mac. “Everywhere” also deletes the index and the people list (names) from the server, for all your devices.") {
        HStack {
          Button("Turn Off on This Mac") { Task { try? await model.search.forget(clearServer: false, api: model.api); model.settings.search = false } }
          Button("Delete Everywhere…") { confirm = true }.disabled(!unlocked)
        }
        if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
    }
    .padding(24)
    .alert("Delete the search index and people everywhere?", isPresented: $confirm) {
      Button("Delete", role: .destructive) {
        Task {
          do { try await model.search.forget(clearServer: true, api: model.api); model.settings.search = false } catch { self.error = error.localizedDescription }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Names you gave people are lost. Turning search on again on any device starts over.") }
    .alert("Which search?", isPresented: $askModel) {
      Button("Standard Search (MobileCLIP, \(size(.mobileclip) ?? "already on this Mac"))") { model.turnOnSearch(explicit: false) }
      Button("Explicit Search (LAION, \(size(.laion) ?? "already on this Mac"))") { model.turnOnSearch(explicit: true) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Explicit search uses a model that also understands explicit content. The choice is for your account: your phone and other devices use the same one. You can change it later here.")
    }
    .alert(explicitAsk == true ? "Turn on explicit search?" : "Turn off explicit search?", isPresented: Binding(get: { explicitAsk != nil }, set: { if !$0 { explicitAsk = nil } })) {
      Button(explicitAsk == true ? "Turn On" : "Turn Off") {
        guard let want = explicitAsk else { return }
        explicitBusy = true
        Task {
          do { try await model.search.setExplicit(want); error = nil } catch { self.error = error.localizedDescription }
          explicitBusy = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(switchText(to: explicitAsk == true ? .laion : .mobileclip))
    }
  }

  /** The download a model needs here now, from what is missing ("about 248 MB"); nil when it is all here. */
  private func size(_ clip: ClipModel) -> String? { model.search.downloadSize(clip, faces: model.settings.faces) }

  private func switchText(to clip: ClipModel) -> String {
    let old = clip == .laion ? "MobileCLIP" : "the explicit model"
    let get = size(clip).map { "downloads \(clip == .laion ? "the explicit model" : "MobileCLIP") (\($0))" } ?? "uses the model already here"
    let then = model.search.indexes ? "and looks at every photo and video again" : "and searches with what your indexing device finds again"
    return "This Mac deletes \(old), \(get) \(then). Your other devices switch too."
  }

  private var indexedBy: String {
    guard let d = indexer, !d.current else { return "Another device indexes your photos." }
    let seen = RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: TimeInterval(d.last_seen)), relativeTo: Date())
    return "Indexed by \(d.device.isEmpty ? "another device" : d.device), last seen \(seen)."
  }

  private func status(_ s: SearchEngine) -> String {
    switch s.phase {
    case .off: return model.phase == .unlocked ? "Starting…" : "Waits until the library is unlocked."
    case .download: return s.downloadText
    case .loading: return "Loading the models…"
    case .indexing: return "Looking at photos: \(s.done) of \(s.total)"
    case .waitPower: return s.message ?? "Waiting for power."
    case .ready:
      if !s.indexes { return s.clip == .laion ? "Ready to search (explicit search), with what the indexing device found." : "Ready to search, with what the indexing device found." }
      return s.clip == .laion ? "Up to date (explicit search)." : "Up to date."
    case .error: return s.message ?? "Stopped."
    }
  }
}

struct ExportSettings: View {
  @Environment(AppModel.self) private var model
  @State private var problem: String?

  var body: some View {
    @Bindable var model = model
    let e = model.exporter
    let unlocked = model.phase == .unlocked
    ScrollView {
    VStack(alignment: .leading, spacing: 20) {
      Section_(title: "Export to a folder", subtitle: "A decrypted copy of your library in a folder on this Mac (or a drive). Anyone with access to this folder can see these photos.") {
        Toggle("Export", isOn: Binding(get: { model.settings.exportOn }, set: { on in
          if on && model.settings.exportPath == nil { choose(thenEnable: true) } else { model.settings.exportOn = on }
        })).disabled(!unlocked)
        HStack {
          Text(model.settings.exportPath.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "No folder chosen").font(Typo.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
          Spacer()
          Button("Choose…") { choose(thenEnable: false) }.disabled(!unlocked)
          if let p = model.settings.exportPath { Button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: p) } }
        }
        Toggle("Keep up to date", isOn: $model.settings.exportKeepUpToDate).disabled(!model.settings.exportOn)
        Text(model.settings.exportKeepUpToDate ? "Runs on its own while the library is unlocked, also with the window closed: new photos from any device arrive within minutes, deleted ones leave." : "Only when you press Export Now.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button("Export Now") { e.exportNow() }.disabled(!model.settings.exportOn || !unlocked || e.phase == .working)
        if let problem { Text(problem).font(Typo.caption).foregroundStyle(Ink.danger) }
        if !unlocked { NeedsUnlock() }
      }
      Section_(title: "What and how") {
        Picker("Folders", selection: $model.settings.exportLayout) {
          Text("By year and month").tag(Exporter.Layout.month)
          Text("By album").tag(Exporter.Layout.album)
        }.fixedSize()
        if model.settings.exportLayout == .album {
          Text("A photo in several albums goes into the first one only; photos in no album go to “Not in an album”.").font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Picker("Export", selection: $model.settings.exportScope) {
          Text("Everything").tag(Exporter.Scope.all)
          Text("Favorites").tag(Exporter.Scope.favorites)
          Text("Chosen albums").tag(Exporter.Scope.albums)
        }.fixedSize()
        if model.settings.exportScope == .albums {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(model.albums.filter { !$0.broken }) { a in
              Toggle(a.name, isOn: Binding(get: { model.settings.exportAlbums.contains(a.id) }, set: { on in
                if on { model.settings.exportAlbums.append(a.id) } else { model.settings.exportAlbums.removeAll { $0 == a.id } }
              })).toggleStyle(.checkbox)
            }
            if model.albums.isEmpty { Text("No albums yet.").font(Typo.caption).foregroundStyle(.secondary) }
          }.padding(.leading, 4)
        }
        Text("No duplicates: each photo is written once; the same photo uploaded twice becomes one file; files already in the folder are kept, not copied again; changing the folders moves the files.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Section_(title: "When something is deleted") {
        Toggle("Move copies of photos deleted from the library to the Trash", isOn: $model.settings.exportTrashRemoved)
        Text("Only unchanged copies; you can put them back from the Trash. Files you rename, move or delete inside the folder are left as they are; the folder is never read back into the library.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button("Export Missing Files Again") { e.exportMissingAgain() }.disabled(!model.settings.exportOn || !unlocked)
      }
      if model.settings.exportOn {
        Section_(title: "Status") {
          Text(e.phase == .working ? "Exporting \(e.done) of \(e.total)\(e.current.map { ": \($0)" } ?? "")" : e.phase == .error ? (e.message ?? "Stopped") : e.phase == .idle ? "Up to date (\(e.total) items)." : unlocked ? "Starting…" : "Waits until the library is unlocked.")
            .font(Typo.caption)
          if e.phase != .error, let m = e.message { Text(m).font(Typo.caption).foregroundStyle(Ink.danger) }
        }
      }
    }
    .padding(24)
    }
    .frame(height: 560)
  }

  private func choose(thenEnable: Bool) {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
    p.prompt = "Export Here"
    p.message = "Choose an empty folder for the decrypted copy of your library."
    guard p.runModal() == .OK, let url = p.url, let me = model.me else { return }
    if let why = Exporter.check(folder: url, userId: me.user.id) { problem = why; return }
    problem = nil
    model.settings.exportPath = url.path
    if thenEnable { model.settings.exportOn = true }
  }
}

struct WatchSettings: View {
  @Environment(AppModel.self) private var model
  @State private var error: String?

  var body: some View {
    @Bindable var model = model
    let w = model.watcher
    VStack(alignment: .leading, spacing: 20) {
      Section_(title: "Upload new files from folders", subtitle: "New photos and videos in these folders are encrypted on this Mac and uploaded seconds after they appear, also while the library is locked. Files your library already has (same name and size) are skipped.") {
        Toggle("Watched folders", isOn: Binding(get: { model.settings.watchOn }, set: { enable($0) }))
          .disabled(model.phase != .unlocked && !model.settings.watchOn)
        if model.phase != .unlocked && !model.settings.watchOn { NeedsUnlock() }
        if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
      Section_(title: "Folders") {
        if model.settings.watched.isEmpty { Text("No folders yet.").font(Typo.caption).foregroundStyle(.secondary) }
        ForEach(model.settings.watched) { f in
          HStack {
            Image(systemName: "folder").foregroundStyle(Ink.teal)
            Text((f.path as NSString).abbreviatingWithTildeInPath).font(Typo.caption).lineLimit(1).truncationMode(.middle)
            Spacer()
            Button { model.settings.watched.removeAll { $0.path == f.path } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless).help("Stop watching").accessibilityLabel("Stop watching \((f.path as NSString).lastPathComponent)")
          }
        }
        HStack {
          Button("Add Folder…") { add() }
          Picker("", selection: $model.settings.watchIncludeExisting) {
            Text("Only files added from now on").tag(false)
            Text("Also the files already in it").tag(true)
          }.labelsHidden().fixedSize()
        }
      }
      if model.settings.watchOn {
        Section_(title: "Status") {
          Text(w.problem ?? (w.running ? (w.current.map { "Uploading \($0) · \(w.waiting) waiting" } ?? "Checking…") : w.lastDone.map { "Up to date, checked \($0.formatted(.relative(presentation: .named)))." } ?? "Waiting."))
            .font(Typo.caption).foregroundStyle(w.problem == nil ? .primary : Ink.danger)
          Text("\(w.uploaded) uploaded from watched folders on this Mac.").font(Typo.caption).foregroundStyle(.secondary)
          ForEach(w.skipped.prefix(5), id: \.self) { s in Text("Skipped: \(s)").font(Typo.small).foregroundStyle(.secondary).lineLimit(1) }
          Button("Check Now") { w.scan() }
        }
      }
    }
    .padding(24)
  }

  /** Turning it on pins the account's public key after checking it against the private key, like the phone's backup. */
  private func enable(_ on: Bool) {
    error = nil
    guard on else { model.settings.watchOn = false; return }
    guard let v = model.vault else { error = "Unlock your library first."; return }
    do {
      let pk = try v.checkedPublicKey()
      model.settings.pubkey = B64.encode(pk)
      model.settings.watchOn = true
      if model.settings.watched.isEmpty { add() }
    } catch {
      self.error = "Your account's keys don't match. Watched folders were not turned on."
    }
  }

  private func add() {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = true
    p.prompt = "Watch"
    p.message = "Choose folders whose new photos and videos should be uploaded."
    guard p.runModal() == .OK else { return }
    for url in p.urls where !model.settings.watched.contains(where: { $0.path == url.path }) {
      if !model.settings.watchIncludeExisting { model.watcher.baseline(url) }
      model.settings.watched.append(WatchedFolder(path: url.path, baselineDone: true))
    }
  }
}

struct MenuBarView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openWindow) private var openWindow
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Mark(size: 20)
        Text("Cipherfilm").font(Typo.name)
        Spacer()
        Text(model.phase == .unlocked ? "Unlocked" : model.phase == .locked ? "Locked" : "Signed out").font(Typo.small.weight(.semibold))
          .padding(.horizontal, 6).padding(.vertical, 2)
          .background(RoundedRectangle(cornerRadius: Radius.pill).fill(model.phase == .unlocked ? Ink.tealTint : Ink.paperDeep))
          .foregroundStyle(model.phase == .unlocked ? Ink.tealInk : Ink.muted)
      }
      if let me = model.me {
        HStack(spacing: 5) {
          Image(systemName: "server.rack").font(Typo.micro)
          Text("\(me.user.email) · \(model.serverName)").lineLimit(1).truncationMode(.middle)
        }.font(Typo.small).foregroundStyle(Ink.muted)
      }
      if model.phase == .unlocked || model.settings.watchOn {
        StatusCard()
      } else {
        Text("Sign in to start.").font(Typo.caption).foregroundStyle(Ink.muted)
      }
      if model.phase == .locked && (model.settings.exportOn || model.settings.search) {
        Text("Export and search wait until you unlock.").font(Typo.small).foregroundStyle(Ink.muted)
      }
      Divider()
      HStack {
        Button("Open Cipherfilm") { model.agent.showWindow(openWindow) }.buttonStyle(PrimaryButton())
        if model.phase == .unlocked { Button("Lock") { model.lock() }.buttonStyle(SecondaryButton()) }
        Spacer()
        Button { NSApp.activate(); openSettings() } label: { Image(systemName: "gearshape") }.buttonStyle(.borderless).help("Settings").accessibilityLabel("Settings")
        Button { AppDelegate.quitting = true; NSApp.terminate(nil) } label: { Image(systemName: "power") }.buttonStyle(.borderless).accessibilityLabel("Quit Cipherfilm").help("Quit Cipherfilm (stops export, watched folders and indexing)")
      }
    }
    .padding(14)
    .frame(width: 300, alignment: .topLeading)
    .fixedSize(horizontal: false, vertical: true)
    .background(Ink.paper.ignoresSafeArea())
    .foregroundStyle(Ink.ink)
    .transaction { $0.animation = nil } // status lines come and go without the panel sliding about
  }
}
