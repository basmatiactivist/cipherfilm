// Settings › Import: watched folders on this Mac (WatchSettings) and WebDAV folders to import from
// (WebDAVImporter.swift).
import CipherfilmCore
import SwiftUI

struct ImportPane: View {
  var body: some View {
    Pane(scrolls: true) {
      WatchSettings()
      PaneDivider()
      WebDAVSettings()
    }
  }
}

struct WebDAVSettings: View {
  @Environment(AppModel.self) private var model
  @State private var adding = false
  @State private var removing: WebDAVSource?

  var body: some View {
    @Bindable var model = model
    Group {
      Section_(title: "WebDAV folders", subtitle: "Photos and videos in a folder on a WebDAV server, such as a network drive, go straight into your timeline: read piece by piece, encrypted on this Mac and uploaded, without a copy of the folder here. Only the folder itself, not its subfolders. Files already in your library (same name and size) are skipped. Runs while your library is unlocked.") {
        if model.settings.webdav.isEmpty { Text("No folders yet.").font(Typo.caption).foregroundStyle(.secondary) }
        ForEach(model.settings.webdav) { s in
          WebDAVSourceRow(source: s, status: model.webdav.status[s.id] ?? .init(), remove: { removing = s })
          Divider()
        }
        Button("Add WebDAV Folder…") { adding = true }.disabled(model.phase != .unlocked || model.me?.isDemo == true)
        if model.phase != .unlocked { NeedsUnlock() }
      }
      Section_(title: "At the same time") {
        Picker("Files at the same time", selection: $model.settings.webdavParallel) {
          ForEach(1...6, id: \.self) { Text("\($0) file\($0 == 1 ? "" : "s")").tag($0) }
        }.labelsHidden().fixedSize()
      }
    }
    .sheet(isPresented: $adding) { AddWebDAVSheet() }
    .confirmationDialog("Remove this folder?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { s in
      Button("Remove", role: .destructive) { model.webdav.remove(s.id) }
    } message: { s in
      Text("Cipherfilm stops importing from \(s.label) and forgets its password. What it imported stays in your library.")
    }
  }
}

struct WebDAVSourceRow: View {
  @Environment(AppModel.self) private var model
  let source: WebDAVSource
  let status: WebDAVImporter.Status
  let remove: () -> Void

  private func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Image(systemName: "network").foregroundStyle(Ink.teal)
        VStack(alignment: .leading, spacing: 1) {
          Text(source.label).font(Typo.caption.weight(.semibold)).lineLimit(1).truncationMode(.middle)
          Text(source.keepImporting ? "Keeps importing new files, every \(Self.every(source.interval))" : "Import once")
            .font(Typo.small).foregroundStyle(.secondary)
        }
        Spacer()
        Button { remove() } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
          .help("Remove").accessibilityLabel("Remove \(source.label)")
      }
      Text(line).font(Typo.caption).foregroundStyle(status.phase == .problem ? Ink.danger : .primary).fixedSize(horizontal: false, vertical: true)
      if status.phase == .importing, status.bytesTotal > 0 {
        ProgressView(value: Double(min(status.bytesDone, status.bytesTotal)), total: Double(status.bytesTotal))
        if !status.current.isEmpty {
          Text(status.current.joined(separator: ", ")).font(Typo.small).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
      }
      if let p = status.plan { Text(counts(p)).font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
      if !status.givenUp.isEmpty || !status.errors.isEmpty || !(status.plan?.unsupported.isEmpty ?? true) {
        DisclosureGroup("Problems and skipped files") {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(status.givenUp.prefix(20), id: \.name) { g in Text("Failed: \(g.name): \(g.why)").font(Typo.small).lineLimit(2) }
            ForEach(status.errors.prefix(10), id: \.self) { e in Text("Will try again: \(e)").font(Typo.small).foregroundStyle(.secondary).lineLimit(2) }
            ForEach((status.plan?.unsupported ?? []).prefix(20), id: \.self) { n in Text("Not a photo or video: \(n)").font(Typo.small).foregroundStyle(.secondary).lineLimit(1) }
            if (status.plan?.unsupported.count ?? 0) > 20 { Text("and \((status.plan?.unsupported.count ?? 0) - 20) more").font(Typo.small).foregroundStyle(.secondary) }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.font(Typo.small)
      }
      HStack {
        if source.paused {
          Button("Resume") { model.webdav.pause(source.id, false) }
        } else {
          Button("Pause") { model.webdav.pause(source.id, true) }.disabled(status.phase == .done && !source.keepImporting)
        }
        Button(source.finished ? "Import Again" : "Import Now") { model.webdav.importNow(source.id) }
          .disabled(model.phase != .unlocked || status.phase == .importing || status.phase == .listing)
        if !status.givenUp.isEmpty { Button("Retry Failed") { model.webdav.retry(source.id) } }
      }.controlSize(.small)
    }
  }

  static func every(_ minutes: Int) -> String { minutes % 60 == 0 ? (minutes == 60 ? "hour" : "\(minutes / 60) hours") : "\(minutes) minutes" }

  private var line: String {
    switch status.phase {
    case .listing: return "Reading the folder…"
    case .importing:
      let total = status.plan?.todo.count ?? 0
      let speed = status.speed > 0 ? " · \(bytes(Int64(status.speed)))/s" : ""
      return "Importing: \(status.uploaded) of \(total) files, \(bytes(status.bytesDone)) of \(bytes(status.bytesTotal))\(speed)"
    case .paused: return "Paused. \(status.imported) imported so far."
    case .problem: return status.problem ?? "Something went wrong. Trying again later."
    case .done: return "Done: \(status.imported) imported\(status.lastChecked.map { ", \($0.formatted(.relative(presentation: .named)))" } ?? "")."
    case .idle:
      if model.phase != .unlocked { return "Waits until your library is unlocked. \(status.imported) imported so far." }
      if let d = status.lastChecked { return "Up to date, checked \(d.formatted(.relative(presentation: .named))). \(status.imported) imported so far." }
      return "Starts in a moment. \(status.imported) imported so far."
    }
  }

  private func counts(_ p: WebDAVImport.Plan) -> String {
    var parts = ["\(p.files) file\(p.files == 1 ? "" : "s") in the folder"]
    if p.done > 0 { parts.append("\(p.done) imported before") }
    if p.inLibrary > 0 { parts.append("\(p.inLibrary) already in your library") }
    if !p.unsupported.isEmpty { parts.append("\(p.unsupported.count) not photos or videos (skipped)") }
    if p.failed > 0 { parts.append("\(p.failed) failed") }
    if p.folders > 0 { parts.append("\(p.folders) subfolder\(p.folders == 1 ? "" : "s") ignored") }
    return parts.joined(separator: " · ")
  }
}

struct AddWebDAVSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var user = ""
  @State private var password = ""
  @State private var keepImporting = false
  @State private var interval = 15
  @State private var onlyNew = false
  @State private var testing = false
  @State private var result: String?
  @State private var error: String?

  private var check: WebDAVAddress.Check { WebDAVAddress.check(address) }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Add a WebDAV Folder").font(Typo.title)
      Form {
        TextField("Address", text: $address, prompt: Text("https://server.example/photos/"))
        TextField("User name", text: $user)
        SecureField("Password", text: $password)
        Picker("Import", selection: $keepImporting) {
          Text("Once").tag(false)
          Text("Keep importing new files").tag(true)
        }
        if keepImporting {
          Picker("Look for new files", selection: $interval) {
            Text("Every 15 minutes").tag(15)
            Text("Every hour").tag(60)
            Text("Every 6 hours").tag(360)
            Text("Every day").tag(1440)
          }
          Picker("Start with", selection: $onlyNew) {
            Text("All files in the folder").tag(false)
            Text("Only files added from now on").tag(true)
          }
        }
      }
      .formStyle(.grouped)
      .onChange(of: address) { result = nil; error = nil }
      if case .unencrypted = check {
        Label("This address isn't encrypted (http). Your password and photos cross your network readable to anyone on it. Use https if the server offers it.", systemImage: "exclamationmark.triangle")
          .font(Typo.caption).foregroundStyle(Ink.danger).fixedSize(horizontal: false, vertical: true)
      }
      if case .invalid(let why) = check, !address.isEmpty { Text(why).font(Typo.caption).foregroundStyle(Ink.danger) }
      if let result { Text(result).font(Typo.caption).fixedSize(horizontal: false, vertical: true) }
      if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger).fixedSize(horizontal: false, vertical: true) }
      Text("The password is kept in this Mac's keychain, readable by Cipherfilm only. The WebDAV server sees this Mac read the folder; your Cipherfilm server sees only encrypted photos, never where they came from.")
        .font(Typo.small).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      HStack {
        if testing { ProgressView().controlSize(.small) }
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Test Connection") { Task { _ = await test() } }.disabled(!valid || testing)
        Button("Add") { Task { await add() } }.keyboardShortcut(.defaultAction).disabled(!valid || testing)
      }
    }
    .padding(20)
    .frame(width: 480)
  }

  private var valid: Bool {
    if case .invalid = check { return false }
    return !user.isEmpty && !password.isEmpty
  }

  private var url: URL? {
    switch check { case .ok(let u), .unencrypted(let u): return u; case .invalid: return nil }
  }

  /** The listing, with what an import would do; nil and the error shown when the folder can't be read. */
  private func test() async -> WebDAVListing? {
    guard let url else { return nil }
    testing = true; error = nil; result = nil
    defer { testing = false }
    do {
      let l = try await WebDAVImporter.listing(url: url, user: user, password: password)
      let p = WebDAVImport.plan(l, book: ImportBook(file: nil), known: model.webdav.knownPrints)
      var s = "Connected. \(p.files) file\(p.files == 1 ? "" : "s"): \(p.todo.count) to import (\(ByteCountFormatter.string(fromByteCount: p.bytes, countStyle: .file)))"
      if p.inLibrary > 0 { s += ", \(p.inLibrary) already in your library" }
      if !p.unsupported.isEmpty { s += ", \(p.unsupported.count) not photos or videos" }
      s += "."
      if p.folders > 0 { s += " \(p.folders) subfolder\(p.folders == 1 ? " is" : "s are") ignored." }
      result = s
      return l
    } catch {
      self.error = error.localizedDescription
      return nil
    }
  }

  private func add() async {
    guard let url, let me = model.me else { return }
    guard let vault = model.vault else { error = "Unlock your library first."; return }
    if model.settings.webdav.contains(where: { $0.url == url.absoluteString && $0.user == user }) { error = "This folder is already in the list."; return }
    guard let listing = await test() else { return }
    do {
      if model.settings.pubkey == nil { model.settings.pubkey = B64.encode(try vault.checkedPublicKey()) }
    } catch {
      self.error = "Your account's keys don't match. Nothing was added."
      return
    }
    let src = WebDAVSource(url: url.absoluteString, user: user, keepImporting: keepImporting, interval: interval)
    do {
      try WebDAVPasswords.set(password, userId: me.user.id, source: src.id)
    } catch {
      self.error = "The password couldn't be saved in the keychain."
      return
    }
    if keepImporting && onlyNew { model.webdav.baseline(src.id, listing) }
    password = ""
    model.settings.webdav.append(src)
    dismiss()
  }
}
