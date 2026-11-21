// Settings: everything the Mac does by itself can be turned on and off here, like search on Android. Laid out like
// the system's own settings windows: a toolbar of panes, each a compact two-column form (a right-aligned label, the
// controls and their short help to its right) at one width, the window taking each pane's height.
import CipherfilmCore
import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    TabView(selection: $model.settingsTab) {
      GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }.tag("general")
      AccountPane().tabItem { Label("Account", systemImage: "person.crop.circle") }.tag("account")
      SecuritySettings().tabItem { Label("Security", systemImage: "lock.shield") }.tag("security")
      SearchSettings().tabItem { Label("Search & People", systemImage: "sparkle.magnifyingglass") }.tag("search")
      ImportPane().tabItem { Label("Import", systemImage: "tray.and.arrow.down") }.tag("import")
      ExportSettings().tabItem { Label("Export", systemImage: "tray.and.arrow.up") }.tag("export")
      NotificationsPane().tabItem { Label("Notifications", systemImage: "bell.badge") }.tag("notifications")
      // only for an administrator, never the public demo login; the server checks every request itself
      if Admin.offered(model.me) {
        AdminSettings().tabItem { Label("Administration", systemImage: "person.2.badge.gearshape") }.tag("admin")
      }
      AboutPane().tabItem { Label("About", systemImage: "info.circle") }.tag("about")
    }
    .tint(Ink.teal)
  }
}

enum PaneMetrics {
  static let width: CGFloat = 680
  static let label: CGFloat = 190
  /** the tallest a pane gets before it scrolls */
  static let maxHeight: CGFloat = 560
}

/** One pane: its rows at the window's width, as tall as they are (scrolls: a fixed height that scrolls, for the panes
 *  whose lists grow). */
struct Pane<Content: View>: View {
  var scrolls = false
  @ViewBuilder let content: Content
  @State private var height: CGFloat = 300
  var body: some View {
    let inner = VStack(alignment: .leading, spacing: 16) { content }
      .padding(.horizontal, 28).padding(.vertical, 22)
      .frame(width: PaneMetrics.width, alignment: .topLeading)
    if scrolls {
      // as tall as its rows, up to maxHeight; past that it scrolls
      ScrollView {
        inner.fixedSize(horizontal: false, vertical: true)
          .background(GeometryReader { g in Color.clear.preference(key: PaneHeight.self, value: g.size.height) })
      }
      .frame(width: PaneMetrics.width, height: min(height, PaneMetrics.maxHeight))
      .onPreferenceChange(PaneHeight.self) { h in if h > 0 { height = h } }
    } else {
      inner.fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct PaneHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/** A row of a pane: its label right-aligned in the left column ("Map:"), the controls in the right one, the help text
 *  below them in small grey type. */
struct Section_<Content: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder let content: Content
  @Environment(\.paneStacked) private var stacked
  var body: some View {
    if stacked {
      VStack(alignment: .leading, spacing: 8) {
        Text(title).font(Typo.title).accessibilityAddTraits(.isHeader)
        if let subtitle { Text(subtitle).font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        content
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      columns
    }
  }

  private var columns: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(title.isEmpty ? "" : title + ":")
        .font(.body)
        .multilineTextAlignment(.trailing)
        .frame(width: PaneMetrics.label, alignment: .trailing)
        .accessibilityAddTraits(.isHeader)
      VStack(alignment: .leading, spacing: 7) {
        content
        if let subtitle { Text(subtitle).font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .contain)
  }
}

extension EnvironmentValues {
  /** a pane of wide lists (Administration): titles above their content instead of in the left column */
  @Entry var paneStacked = false
}

/** A thin line between groups of rows, as in the system's settings. */
struct PaneDivider: View {
  var body: some View { Divider().padding(.vertical, 2) }
}

struct NeedsUnlock: View {
  var body: some View {
    Label("Unlock your library to change this.", systemImage: "lock").font(Typo.caption).foregroundStyle(.secondary)
  }
}

struct GeneralSettings: View {
  @Environment(AppModel.self) private var model
  @AppStorage("memoriesOn") private var memoriesOn = true
  // the same keys as AppModel.lockOnSleep and StayUnlocked.on: through @AppStorage so a click redraws the switch
  @AppStorage("lockOnSleep") private var lockOnSleep = true
  @AppStorage("stayUnlockedWhileWorking") private var stayUnlocked = false
  @State private var customReviews = false

  var body: some View {
    @Bindable var agent = model.agent
    Pane {
      Section_(title: "Menu bar", subtitle: "With the window closed, Cipherfilm keeps exporting, uploading watched folders and indexing from the menu bar. To quit, use the power button in the menu-bar panel.") {
        Toggle("Keep running in the menu bar after closing or ⌘Q", isOn: $agent.keepRunning)
        Toggle("Open at login", isOn: Binding(get: { model.agent.openAtLogin }, set: { model.agent.setOpenAtLogin($0) }))
        if let p = model.agent.loginProblem { Text(p).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
      Section_(title: "Lock") {
        Toggle("Lock when this Mac sleeps or its screen locks", isOn: $lockOnSleep)
        Toggle("Stay unlocked while an import or export runs", isOn: $stayUnlocked)
          .onChange(of: stayUnlocked) { model.workChanged() }
        Text("For long WebDAV imports and exports: when the screen turns off or locks, Cipherfilm locks once the work is done, and this Mac stays awake until then. Closing the lid or choosing Sleep still locks at once.")
          .font(Typo.caption).foregroundStyle(.secondary)
      }
      PaneDivider()
      // the map's images come from a third party: off until turned on, per account on this Mac (MapPage.swift)
      Section_(title: "Map", subtitle: "Map images from \(MapConsent.providerLong(model.me?.map)); a photo's small map in its details loads after Show Map.") {
        Toggle("Show your photos on a map", isOn: Binding(get: { model.mapOn }, set: { model.mapOn = $0 }))
          .disabled(model.me == nil || model.me?.hasMap != true)
        if model.me != nil && model.me?.hasMap != true { Text("This server doesn't offer a map.").font(Typo.caption).foregroundStyle(.secondary) }
      }
      Section_(title: "Memories", subtitle: "Worked out on this Mac from the encrypted dates and places; the server learns nothing unless you save a trip as an album.") {
        Toggle("Show “On this day”, year recaps and trips", isOn: $memoriesOn)
        HStack {
          Button("Custom reviews…") { customReviews = true }.disabled(model.vault == nil)
          if model.vault == nil { NeedsUnlock() }
        }
      }
    }
    .sheet(isPresented: $customReviews) { CustomReviewsSheet().environment(model) }
  }
}

/** Account: who is signed in where, lock, sign-out and deletion; the account's storage and devices' last uploads. */
struct AccountPane: View {
  @Environment(AppModel.self) private var model
  @State private var signOut = false
  @State private var deleteAccount = false

  var body: some View {
    Pane {
      if let me = model.me {
        Section_(title: "Signed in as") {
          Text(me.user.email).textSelection(.enabled)
          if me.isDemo { Text(Me.demoNote).font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.teal) }
        }
        if model.server != nil { Section_(title: "Server") { Text(model.serverName).textSelection(.enabled) } }
        Section_(title: "This Mac", subtitle: "Signing out deletes this account's data from this Mac. Locking only forgets the keys; watched folders keep uploading.") {
          HStack {
            Button("Lock") { model.lock() }.disabled(model.phase != .unlocked)
            Button("Sign Out…") { signOut = true }
          }
        }
        if !me.isDemo {
          Section_(title: "Delete", subtitle: "Deletes the account and everything in it from the server.") {
            Button("Delete Account…", role: .destructive) { deleteAccount = true }
          }
        }
        PaneDivider()
        MyStorageSection()
      } else {
        Section_(title: "Account") { Text("Not signed in.").foregroundStyle(.secondary) }
      }
    }
    .sheet(isPresented: $signOut) { SignOutSheet().environment(model) }
    .sheet(isPresented: $deleteAccount) { DeleteAccountSheet().environment(model) }
  }
}

/** Notifications: when background work finishes, and new sign-ins to the account. */
struct NotificationsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Pane {
      Section_(title: "Background work", subtitle: "Uploads, watched folders, WebDAV imports, the first export and the first full index.") {
        Toggle("Notify when uploads, exports and indexing finish", isOn: Binding(get: { Notifier.enabled }, set: { Notifier.enabled = $0 }))
      }
      if model.me?.isDemo != true { NoticeNotificationsSection() }
    }
  }
}

/** About: versions, the credits the map, place names and text model ask for, and the problem report. */
struct AboutPane: View {
  @Environment(AppModel.self) private var model
  /** The map's credit when the server offers one: OpenStreetMap and OpenFreeMap for the default, else the map's own. */
  private var mapCredit: String? {
    guard let m = model.me?.map else { return nil }
    return m.isDefault ? "Map: © OpenStreetMap contributors, © OpenMapTiles · MapLibre GL JS (BSD-3-Clause)" : "Map: MapLibre GL JS (BSD-3-Clause); its data is credited on the map"
  }

  var body: some View {
    Pane {
      Section_(title: "Cipherfilm") {
        Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")").textSelection(.enabled)
      }
      if let v = model.me?.server_version { Section_(title: "Server") { Text("Version \(v)").textSelection(.enabled) } }
      Section_(title: "Components") {
        Text("libsodium \(Sodium.version) · ONNX Runtime \(Vision.runtimeVersion)").foregroundStyle(.secondary)
      }
      // the map's, the place names' and the text model's sources ask to be named (OpenStreetMap: ODbL; GeoNames: CC BY
      // 4.0; PaddleOCR: Apache 2.0)
      Section_(title: "Credits") {
        VStack(alignment: .leading, spacing: 3) {
          if let mapCredit { Text(mapCredit) }
          Text("Place names: GeoNames (geonames.org), CC BY 4.0")
          Text("Text recognition: PaddleOCR models, Apache 2.0")
        }.font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      PaneDivider()
      Section_(title: "Problems", subtitle: "Opens the issue form in the browser. You see what it fills in first.") {
        Button("Report a Problem…") { ReportProblem.ask(model) }
      }
    }
  }
}

/** Settings › Security, below Devices: the account's own storage and its devices' last uploads (GET /api/me/storage),
 *  compact. On the public demo login the server lists only this device. */
struct MyStorageSection: View {
  @Environment(AppModel.self) private var model
  @State private var storage: StorageOverview.Account?
  @State private var error: String?

  var body: some View {
    Section_(title: "Storage and backup", subtitle: "What your library takes on the server, and when each of your devices last uploaded.") {
      if let storage {
        AccountStorageView(account: storage, compact: true)
      } else if let error {
        Text(error).font(Typo.caption).foregroundStyle(.secondary)
      } else {
        ProgressView().controlSize(.small)
      }
    }
    .task(id: model.me?.user.id) { await load() }
  }

  private func load() async {
    guard let api = model.api else { return }
    do { storage = try await StorageOverview.mine(api: api); error = nil }
    catch { self.error = (error as? APIError)?.status == 404 ? "This server doesn't show storage details yet." : (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
  }
}

/** Deletes the account and everything in it from the server, permanently, after a warning and the password (and, while
 *  two-step sign-in is on, the second step: the same choices as for turning it off). */
struct DeleteAccountSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var sure = false
  @State private var busy = false
  @State private var error: String?
  /** two-step sign-in is on: as the account said at sign-in, or as the server said when asked for the deletion */
  @State private var on = false
  @State private var hasApp = true
  @State private var hasPasskey = false
  @State private var code = ""
  @State private var way: CodeStepView.Way = .code

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Delete your account?").font(Typo.dialog)
      Text("Your account and all photos, videos, albums, people and search data are deleted from \(model.serverName) right away. Nobody can bring them back, not even an administrator. All your devices are signed out and delete what they keep.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      Text("Exported copies on this Mac stay where they are.").font(Typo.caption).foregroundStyle(Ink.faint)
      SecureField("Your password", text: $password).textContentType(.password)
      if on { SecondStepFields(code: $code, way: $way, hasApp: hasApp, hasPasskey: hasPasskey) }
      Toggle("I understand my photos and videos are deleted permanently", isOn: $sure).toggleStyle(.checkbox)
      if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
        Button(action: go) { BusyLabel(busy, "Delete Account", "Deleting…") }.buttonStyle(PrimaryButton())
          .disabled(busy || !sure || password.isEmpty || (on && !SecondStepFields.ready(code, way)))
      }
    }
    .padding(24).frame(width: 460)
    .background(Ink.card)
    .task { if model.me?.two_factor == true { await askSecond() } }
  }

  /** Shows the second step, with the choices the account has (the authenticator app, a passkey for this server); not
   *  when the server says two-step sign-in is off by now, unless it just asked for the step. */
  private func askSecond(asked: Bool = false) async {
    if let api = model.api {
      let s = try? await TwoFactor.status(api: api)
      if s?.enabled == false && !asked { return }
      hasApp = s?.hasApp ?? true
      hasPasskey = ((try? await Passkeys.list(api: api)) ?? []).contains { $0.here }
    }
    if !on { way = SecondStepFields.start(hasApp: hasApp, hasPasskey: hasPasskey) }
    on = true
  }

  private func go() {
    guard let api = model.api, !busy, sure, !password.isEmpty, !on || SecondStepFields.ready(code, way) else { return }
    busy = true; error = nil
    let pw = password
    Task {
      do {
        let s2 = try await secondStep(api, on: on, way: way, code: code)
        try await model.deleteAccount(password: pw, second: s2)
        dismiss()
      } catch {
        // two-step sign-in was turned on since this Mac last looked: ask for the step now
        let wasOn = on
        if TwoFactor.needsSecondStep(error) { await askSecond(asked: true) }
        self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if wasOn { code = "" }
      }
      busy = false
    }
  }
}

struct SearchSettings: View {
  @Environment(AppModel.self) private var model
  @State private var confirm = false
  @State private var error: String?
  @State private var explicitBusy = false
  @State private var indexer: SearchEngine.Device?
  @State private var takingOver = false
  /** the question before a model download (ModelConsent.swift), and what to do after the yes */
  @State private var consent: PendingConsent?
  @State private var offAsk = false

  struct PendingConsent: Identifiable { let ask: ModelConsentAsk; let then: () -> Void; var id: String { ask.id } }

  /** Runs `then` at once when it downloads nothing new; otherwise after the person agreed to the download. */
  private func withConsent(_ clip: ClipModel, faces: Bool, reader: Bool? = nil, then: @escaping () -> Void) {
    let store = model.search.models
    Task { @MainActor in
      // the files here count once their hash is checked (ModelStore.unagreed), off the main thread
      await Task.detached { store.checkHere() }.value
      guard let a = model.search.consentAsk(clip, faces: faces, reader: reader) else { then(); return }
      // (from an alert's button: the sheet opens once the alert is gone)
      consent = PendingConsent(ask: a, then: then)
    }
  }

  /** Text in photos: its model is asked for on its own (a no leaves search as it is). */
  private func withOcrConsent(then: @escaping () -> Void) {
    let store = model.search.models
    Task { @MainActor in
      await Task.detached { store.checkHere() }.value
      guard let a = model.search.ocrAsk() else { then(); return }
      consent = PendingConsent(ask: a, then: then)
    }
  }

  var body: some View {
    @Bindable var model = model
    let unlocked = model.phase == .unlocked
    Pane(scrolls: true) {
      Section_(title: "Search", subtitle: "Runs on this Mac with open models\(size(.clip).map { ", \($0)" } ?? ", already on this Mac"). Results are encrypted and stored on your server, shared with your other devices.") {
        Toggle("Search and people", isOn: Binding(get: { model.settings.search }, set: { on in
          if on { withConsent(.clip, faces: model.settings.faces) { model.turnOnSearch() } }
          // off: the models stay unless the person deletes them (asked when there are any)
          else if model.search.models.downloaded() != nil { offAsk = true }
          else { model.settings.search = false; model.settings.searchAsked = true }
        }))
          .disabled(!unlocked)
        // where the models come from, said before anything is downloaded (docs/MODELS.md)
        if let d = model.search.models.downloaded() {
          Text(d.at.map { "Models downloaded on \($0.formatted(date: .abbreviated, time: .omitted)), \(ModelConsentSheet.mb(d.bytes))." } ?? "Models downloaded, \(ModelConsentSheet.mb(d.bytes)).")
            .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Text("Downloaded once from the site where the models are published, after you agree. That site sees this Mac's IP address, nothing of your photos.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Toggle("Group faces into people", isOn: Binding(get: { model.settings.faces }, set: { on in
          if on && model.settings.search { withConsent(model.search.clip, faces: true) { model.settings.faces = true } } else { model.settings.faces = on }
        })).disabled(!unlocked || !model.settings.search)
        Toggle("Also while on battery", isOn: $model.settings.indexOnBattery).disabled(!model.settings.search)
        // the words in photos (signs, receipts, screenshots), read by the Mac that indexes; off deletes its model
        Toggle("Text in photos", isOn: Binding(get: { model.settings.textInPhotos }, set: { on in
          if on { withOcrConsent { model.settings.textInPhotos = true } }
          else { model.settings.textInPhotos = false; model.search.models.removeOcr() }
        })).disabled(!unlocked || !model.settings.search || !model.search.indexes)
        Text(model.search.indexes
             ? "Finds photos by the words in them, read on this Mac with an open model (about \(ModelConsentSheet.mb(Models.ocrFiles.reduce(0) { $0 + $1.size }))). Turning it off deletes that model."
             : "The device that indexes your photos reads the text in them.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if !unlocked { NeedsUnlock() }
      }
      // only for a person an admin allowed it (docs/SEARCH.md, "Explicit content")
      if model.me?.user.nsfw == true && model.settings.search {
        let on = model.search.people.explicit == true
        Section_(title: "Explicit search", subtitle: "Off, search leaves out photos and words it takes for explicit content. On, it finds everything. Applies to all your devices (not the Android app from the app store, which always leaves them out).") {
          Toggle("Explicit search", isOn: Binding(get: { on }, set: { want in
            explicitBusy = true
            Task {
              do { try await model.search.setExplicit(want); error = nil } catch { self.error = error.localizedDescription }
              explicitBusy = false
            }
          }))
            .disabled(!unlocked || explicitBusy || model.search.phase == .off)
        }
      }
      if model.settings.search {
        let s = model.search
        let c = s.index.count
        Section_(title: "Status") {
          Text(status(s)).font(Typo.caption)
          if s.phase == .consent { Button("Download…") { consent = PendingConsent(ask: s.pendingAsk(), then: {}) }.disabled(!unlocked) }
          if s.ocrWaiting && model.settings.textInPhotos, let a = s.ocrAsk() {
            Text("Text in photos waits for your OK to download its model.").font(Typo.caption)
            Button("Download…") { consent = PendingConsent(ask: a, then: {}) }.disabled(!unlocked)
          } else if s.textLeft > 0 {
            Text("Reading the text in photos indexed before: \(s.textLeft) left.").font(Typo.caption).foregroundStyle(.secondary)
          }
          Text("\(c.items) photos and videos indexed, \(c.faces) faces.").font(Typo.caption).foregroundStyle(.secondary)
        }
        // one device per account looks at the photos; the others read what it found (docs/SEARCH.md)
        Section_(title: "Which device indexes", subtitle: "One device indexes your photos. The others use its results and download only the text model.") {
          if s.indexes {
            Text("This Mac indexes your photos.").font(Typo.caption)
          } else {
            Text(indexedBy).font(Typo.caption)
            // that device may have stopped (it waits for its own OK to download the models after an update, or is
            // gone): said, so it is clear why search misses photos and what to do
            if s.phase == .ready && s.waiting > 0 {
              Text("\(s.waiting) \(s.waiting == 1 ? "photo or video isn't" : "photos and videos aren't") indexed yet. If that device no longer indexes, index on this Mac instead.")
                .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Button(takingOver ? "Switching…" : "Index on This Mac Instead") {
              withConsent(s.clip, faces: model.settings.faces, reader: false) {
                takingOver = true
                Task {
                  do { if let api = model.api { try await model.search.indexHere(api: api) }; error = nil } catch { self.error = error.localizedDescription }
                  takingOver = false
                }
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
      PaneDivider()
      Section_(title: "Turn off and delete", subtitle: "Removes the models and index from this Mac; turning search on again asks before downloading them. “Everywhere” also deletes the index and people names from the server.") {
        HStack {
          Button("Turn Off on This Mac") { Task { try? await model.search.forget(clearServer: false, api: model.api); model.settings.search = false } }
          Button("Delete Everywhere…") { confirm = true }.disabled(!unlocked)
        }
        if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
      }
    }
    .alert("Delete the search index and people everywhere?", isPresented: $confirm) {
      Button("Delete", role: .destructive) {
        Task {
          do { try await model.search.forget(clearServer: true, api: model.api); model.settings.search = false } catch { self.error = error.localizedDescription }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: { Text("People names are lost. Turning search on again starts over.") }
    .sheet(item: $consent) { p in
      ModelConsentSheet(ask: p.ask, yes: { consent = nil; model.search.agree(p.ask); p.then() }, later: { consent = nil })
    }
    .alert("Turn off search on this Mac?", isPresented: $offAsk) {
      Button("Turn Off and Delete the Models") { Task { try? await model.search.forget(clearServer: false, api: model.api); model.settings.search = false; model.settings.searchAsked = true } }
      Button("Turn Off, Keep the Models") { model.settings.search = false; model.settings.searchAsked = true }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Deleting the models frees their space; turning search on again then asks before downloading them.") }
  }

  /** The download a model needs here now, from what is missing ("about 248 MB"); nil when it is all here. */
  private func size(_ clip: ClipModel) -> String? { model.search.downloadSize(clip, faces: model.settings.faces) }

  private var indexedBy: String {
    guard let d = indexer, !d.current else { return "Another device indexes your photos." }
    let seen = RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: TimeInterval(d.last_seen)), relativeTo: Date())
    return "Indexed by \(d.device.isEmpty ? "another device" : d.device), last seen \(seen)."
  }

  private func status(_ s: SearchEngine) -> String {
    switch s.phase {
    case .off: return model.phase == .unlocked ? "Starting…" : "Waits until the library is unlocked."
    case .consent: return "Waiting for your OK to download the models (\(ModelConsentSheet.mb(Int64(s.total))))."
    case .download: return s.downloadText
    case .loading: return "Loading the models…"
    case .indexing: return "Indexing \(s.done) of \(s.total)"
    case .waitPower: return s.message ?? "Waiting for power."
    case .ready:
      if !s.indexes { return s.filtered ? "Ready, using the indexing device's results." : "Ready (explicit search), using the indexing device's results." }
      return s.filtered ? "Up to date." : "Up to date (explicit search)."
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
    Pane(scrolls: true) {
      Section_(title: "Export to a folder", subtitle: "A decrypted copy of your library in a folder on this Mac or a drive. Anyone with access to the folder can see the photos.") {
        Toggle("Keep a decrypted copy in a folder", isOn: Binding(get: { model.settings.exportOn }, set: { on in
          if on && model.settings.exportPath == nil { choose(thenEnable: true) } else { model.settings.exportOn = on }
        })).disabled(!unlocked)
        HStack {
          Text(model.settings.exportPath.map { ($0 as NSString).abbreviatingWithTildeInPath } ?? "No folder chosen").font(Typo.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
          Spacer()
          Button("Choose…") { choose(thenEnable: false) }.disabled(!unlocked)
          if let p = model.settings.exportPath { Button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: p) } }
        }
        Toggle("Keep up to date", isOn: $model.settings.exportKeepUpToDate).disabled(!model.settings.exportOn)
        Text(model.settings.exportKeepUpToDate ? "Runs while unlocked, also with the window closed. Changes from any device arrive within minutes." : "Only when you click Export Now.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button("Export Now") { e.exportNow() }.disabled(!model.settings.exportOn || !unlocked || e.phase == .working)
        if let problem { Text(problem).font(Typo.caption).foregroundStyle(Ink.danger) }
        if !unlocked { NeedsUnlock() }
      }
      Section_(title: "Folders") {
        Picker("Folders", selection: $model.settings.exportLayout) {
          Text("By year and month").tag(Exporter.Layout.month)
          Text("By album").tag(Exporter.Layout.album)
        }.labelsHidden().fixedSize()
        if model.settings.exportLayout == .album {
          Text("A photo in several albums goes into the first one. Photos in no album go to “Not in an album”.").font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
      Section_(title: "What", subtitle: "Each photo is written once, even if uploaded twice. Existing files are kept. Changing the layout moves the files.") {
        Picker("Export", selection: $model.settings.exportScope) {
          Text("Everything").tag(Exporter.Scope.all)
          Text("Favorites").tag(Exporter.Scope.favorites)
          Text("Chosen albums").tag(Exporter.Scope.albums)
        }.labelsHidden().fixedSize()
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
      }
      Section_(title: "Deleted photos") {
        Toggle("Move copies of deleted photos to the Trash", isOn: $model.settings.exportTrashRemoved)
        Text("Only unchanged copies. Changes you make in the folder are left alone and never read back into the library.")
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
  }

  private func choose(thenEnable: Bool) {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
    p.prompt = "Export Here"
    p.message = "Choose an empty folder for the decrypted copy."
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
    Group {
      Section_(title: "Watched folders", subtitle: "New photos and videos here are encrypted and uploaded within seconds, even while locked. Files already in your library (same name and size) are skipped.") {
        Toggle("Upload new files from folders on this Mac", isOn: Binding(get: { model.settings.watchOn }, set: { enable($0) }))
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
            Text("Also existing files").tag(true)
          }.labelsHidden().fixedSize()
        }
      }
      if model.settings.watchOn {
        Section_(title: "Watching") {
          Text(w.problem ?? (w.running ? (w.current.map { "Uploading \($0) · \(w.waiting) waiting" } ?? "Checking…") : w.lastDone.map { "Up to date, checked \($0.formatted(.relative(presentation: .named)))." } ?? "Waiting."))
            .font(Typo.caption).foregroundStyle(w.problem == nil ? .primary : Ink.danger)
          Text("\(w.uploaded) uploaded from watched folders on this Mac.").font(Typo.caption).foregroundStyle(.secondary)
          ForEach(w.skipped.prefix(5), id: \.self) { s in Text("Skipped: \(s)").font(Typo.small).foregroundStyle(.secondary).lineLimit(1) }
          Button("Check Now") { w.scan() }
        }
      }
    }
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
      self.error = "Your account's keys don't match. Watched folders are off."
    }
  }

  private func add() {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = true
    p.prompt = "Watch"
    p.message = "Choose folders to upload new photos and videos from."
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
        Button { AppDelegate.quitting = true; NSApp.terminate(nil) } label: { Image(systemName: "power") }.buttonStyle(.borderless).accessibilityLabel("Quit Cipherfilm").help("Quit Cipherfilm and stop export, watched folders and indexing")
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
