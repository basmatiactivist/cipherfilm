// Settings › Security: two-step sign-in (server/twofactor.go) and the account's signed-in devices; and the toolbar's
// bell with the account's notices (a new sign-in elsewhere, two-step sign-in turned off or changed).
import AppKit
import CipherfilmCore
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

struct SecuritySettings: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        if let me = model.me {
          if !me.isDemo {
            TwoFactorSection()
            Divider()
          }
          DevicesSection()
          if !me.isDemo {
            Divider()
            NoticeNotificationsSection()
          }
        } else {
          Text("Not signed in.").foregroundStyle(.secondary)
        }
      }
      .padding(24)
    }
    .frame(height: 560)
  }
}

private func say(_ error: Error) -> String { (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }

/** Notices as macOS notifications (Notifier.swift NoticeNotifier). */
struct NoticeNotificationsSection: View {
  @State private var on = NoticeNotifier.enabled

  var body: some View {
    Section_(title: "Notifications", subtitle: "While the window isn't in front, or Cipherfilm is locked and runs in the menu bar, a notification tells you about a new sign-in to your account. Its preview shows the device and the time; where macOS hides previews (the lock screen, by default), only that there was a new sign-in.") {
      Toggle("Notify me about new sign-ins", isOn: Binding(get: { on }, set: { on = $0; NoticeNotifier.enabled = $0 }))
    }
  }
}

// ---- two-step sign-in ----

/** A secret copied on purpose (the setup key, the recovery codes): marked concealed, so clipboard managers that honour
 *  org.nspasteboard.ConcealedType don't keep or show it, and taken off the clipboard after a minute unless something
 *  else was copied since. */
@MainActor func copySecret(_ text: String) {
  let pb = NSPasteboard.general
  let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
  pb.clearContents()
  pb.declareTypes([.string, concealed], owner: nil)
  pb.setString(text, forType: .string)
  pb.setString("", forType: concealed)
  let mine = pb.changeCount
  DispatchQueue.main.asyncAfter(deadline: .now() + 60) { if pb.changeCount == mine { pb.clearContents() } }
}

struct TwoFactorSection: View {
  @Environment(AppModel.self) private var model
  @State private var status: TwoFactor.Status?
  @State private var keys: [Passkeys.Item] = []
  @State private var error: String?
  @State private var setup = false
  @State private var action: ProofSheet.Mode?
  @State private var shownCodes: [String]?

  private var on: Bool { status?.enabled ?? false }
  private var hasApp: Bool { status?.hasApp ?? false }
  private var hereKeys: Bool { keys.contains { $0.here } }

  var body: some View {
    Section_(title: "Two-step sign-in", subtitle: "After your password, signing in on a new device also asks for a code from an authenticator app, or a passkey. Unlocking this Mac doesn't. Your password still unlocks your photos.") {
      if let s = status {
        if s.enabled {
          Label("On. \(s.recovery_codes_left) of 10 recovery codes left.", systemImage: "checkmark.shield").font(Typo.caption).foregroundStyle(Ink.ok)
          if s.recovery_codes_left <= 3 { Text("Make new recovery codes soon: each one works once.").font(Typo.caption).foregroundStyle(Ink.danger) }
          HStack {
            Text(hasApp ? "Authenticator app: on" : "Authenticator app: off").font(Typo.caption)
            Spacer()
            if hasApp {
              if !keys.isEmpty { Button("Remove App…") { action = .removeApp } }
            } else {
              Button("Add Authenticator App…") { setup = true }
            }
          }
          VStack(alignment: .leading, spacing: 6) {
            Text("Passkeys").font(Typo.label)
            ForEach(keys) { k in
              HStack {
                Image(systemName: "person.badge.key").foregroundStyle(Ink.teal).frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                  Text(k.name).font(Typo.body)
                  Text(k.last_used_at > 0 ? "Last used \(Date(timeIntervalSince1970: TimeInterval(k.last_used_at)).formatted(date: .abbreviated, time: .omitted))" + (k.here ? "" : " · \(k.rp_id)")
                       : "Not used yet" + (k.here ? "" : " · \(k.rp_id)")).font(Typo.caption).foregroundStyle(Ink.muted)
                }
                Spacer()
                Button("Remove…") { action = .removeKey(k) }
              }
            }
            Button("Add Passkey…") { action = .addKey }
            Text("Passkeys are made and used in your browser, on your server's own address.").font(Typo.caption).foregroundStyle(Ink.faint)
          }
          HStack {
            Button("New Recovery Codes…") { action = .codes }
            Button("Turn Off…") { action = .off }
          }
        } else {
          Text("Off. Your password alone signs in.").font(Typo.caption).foregroundStyle(.secondary)
          HStack {
            Button("Turn On With an Authenticator App…") { setup = true }
            Button("Turn On With a Passkey…") { action = .addKey }
          }
        }
      } else if error == nil {
        ProgressView().controlSize(.small)
      }
      if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
    }
    .task { await load() }
    .sheet(isPresented: $setup, onDismiss: { Task { await load() } }) {
      TwoFactorSetupSheet(second: on, hasPasskey: hereKeys).environment(model)
    }
    .sheet(item: $action, onDismiss: { Task { await load() } }) { m in
      ProofSheet(mode: m, on: on, hasApp: hasApp, hasPasskey: hereKeys, onlyStep: keys.count == 1 && !hasApp) { codes in shownCodes = codes }.environment(model)
    }
    .sheet(isPresented: Binding(get: { shownCodes != nil }, set: { if !$0 { shownCodes = nil } })) {
      VStack(alignment: .leading, spacing: 14) {
        RecoveryCodesView(codes: shownCodes ?? [], fresh: true)
        HStack { Spacer(); Button("I Saved Them") { shownCodes = nil }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction) }
      }
      .padding(24).frame(width: 460).background(Ink.card)
    }
  }

  private func load() async {
    guard let api = model.api else { return }
    do {
      status = try await TwoFactor.status(api: api)
      keys = (try? await Passkeys.list(api: api)) ?? []
      error = nil
    } catch { self.error = say(error) }
    await model.refreshMe()
  }
}

/** The second step a change asks for while two-step sign-in is on: the app's code, a recovery code, or a passkey (in
 *  the browser, when the change is sent). */
struct SecondStepFields: View {
  @Binding var code: String
  @Binding var way: CodeStepView.Way
  let hasApp: Bool
  let hasPasskey: Bool
  var onSubmit: () -> Void = {}

  static func start(hasApp: Bool, hasPasskey: Bool) -> CodeStepView.Way { hasApp ? .code : hasPasskey ? .passkey : .recovery }
  static func ready(_ code: String, _ way: CodeStepView.Way) -> Bool { way == .passkey || TwoFactor.ready(code, recovery: way == .recovery) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      switch way {
      case .passkey:
        Text("Your browser opens for your passkey when you continue.").font(Typo.caption).foregroundStyle(Ink.muted)
      case .recovery:
        FieldLabel(text: "Recovery code")
        TextField("xxxx-xxxx-xxxx-xxxx", text: $code).field().autocorrectionDisabled().onSubmit(onSubmit)
      case .code:
        FieldLabel(text: "Code from your authenticator app")
        TextField("123456", text: $code).field().textContentType(.oneTimeCode).onSubmit(onSubmit)
      }
      HStack(spacing: 14) {
        if way != .code, hasApp { Button("Use the authenticator app") { way = .code; code = "" }.buttonStyle(TextLink()).font(Typo.caption) }
        if way != .passkey, hasPasskey { Button("Use a passkey") { way = .passkey; code = "" }.buttonStyle(TextLink()).font(Typo.caption) }
        if way != .recovery { Button("Use a recovery code") { way = .recovery; code = "" }.buttonStyle(TextLink()).font(Typo.caption) }
      }
    }
  }
}

/** What the second step sends: the code as typed, or a passkey's answer to this session's challenge (in the browser). */
@MainActor func secondStep(_ api: API, on: Bool, way: CodeStepView.Way, code: String) async throws -> TwoFactor.Second {
  guard on else { return .none }
  switch way {
  case .code, .recovery: return .code(code)
  case .passkey:
    let options = try await Passkeys.proofChallenge(api: api)
    return .passkey(try await PasskeyBrowser.shared.run(server: api.base, op: "get", options: options))
  }
}

/** The ten recovery codes, shown once, with Copy. */
struct RecoveryCodesView: View {
  let codes: [String]
  var fresh = false
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(fresh ? "Your recovery codes" : "Recovery codes").font(Typo.dialog)
      Text("If you lose your phone or your passkeys, each of these signs in once instead. Keep them somewhere safe, like a password manager. They are shown only now.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 6) {
        ForEach(codes, id: \.self) { Text($0).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
      }
      .padding(12)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Ink.paperDeep))
      Button(copied ? "Copied for a Minute" : "Copy Codes") {
        copySecret(codes.joined(separator: "\n"))
        copied = true
      }.buttonStyle(SecondaryButton())
    }
  }
}

/** A QR code made on this Mac (CoreImage), so the secret never goes to a QR service. */
struct QRImage: View {
  let text: String
  var body: some View {
    if let img = Self.image(text) {
      Image(nsImage: img).interpolation(.none).resizable().frame(width: 180, height: 180)
        .padding(10).background(Color.white).accessibilityLabel("QR code for your authenticator app")
    }
  }

  static func image(_ text: String) -> NSImage? {
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: out.extent.width, height: out.extent.height))
  }
}

/** Adding the authenticator app: the password (and a second step while a passkey has two-step sign-in on), then the
 *  secret (to the Passwords app or an authenticator in one click, or QR and text) and a code from it, then the
 *  recovery codes when it is the first second step. */
struct TwoFactorSetupSheet: View {
  var second = false
  var hasPasskey = false
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var setup: TwoFactor.Setup?
  @State private var code = ""
  @State private var proofCode = ""
  @State private var way: CodeStepView.Way = .passkey
  @State private var codes: [String]?
  @State private var busy = false
  @State private var error: String?
  @State private var copied = false
  @State private var opened: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let codes {
        RecoveryCodesView(codes: codes, fresh: true)
        Note(text: "Two-step sign-in is on.", ok: true)
        HStack { Spacer(); Button("I Saved Them") { dismiss() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction) }
      } else if let setup {
        Text("Add Cipherfilm to your authenticator app").font(Typo.dialog)
        Text("Open it in your password manager or authenticator app on this Mac, or scan the code with your password manager or authenticator app on your phone, or type the key in.")
          .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
        Button("Open in Password Manager or Authenticator App") {
          // otpauth:// is opened by the app registered for it (macOS Passwords on recent macOS, or another authenticator)
          if let u = setup.totpURL, NSWorkspace.shared.open(u) { opened = "Opened. Add the account there, then enter the code it shows." }
          else { opened = "No app on this Mac opens it. Scan the code with your phone, or copy the key." }
        }.buttonStyle(SecondaryButton())
        if let opened { Text(opened).font(Typo.caption).foregroundStyle(Ink.muted) }
        HStack(alignment: .top, spacing: 16) {
          QRImage(text: setup.uri)
          VStack(alignment: .leading, spacing: 8) {
            FieldLabel(text: "Key")
            Text(TwoFactor.grouped(setup.secret)).font(.system(.body, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Button(copied ? "Copied for a Minute" : "Copy Key") {
              copySecret(setup.secret)
              copied = true
            }.buttonStyle(SecondaryButton())
            Text("Time-based, 6 digits, every 30 seconds.").font(Typo.caption).foregroundStyle(Ink.faint)
          }
        }
        VStack(alignment: .leading, spacing: 6) {
          FieldLabel(text: "Code from the app")
          TextField("123456", text: $code).field().textContentType(.oneTimeCode).onSubmit(enable)
            .onChange(of: code) { _, v in let d = String(v.filter(\.isNumber).prefix(6)); if d != v { code = d } }
        }
        if let error { Note(text: error) }
        HStack {
          Spacer()
          Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
          Button(action: enable) { BusyLabel(busy, "Turn On", "Checking…") }.buttonStyle(PrimaryButton())
            .disabled(busy || !TwoFactor.ready(code, recovery: false)).keyboardShortcut(.defaultAction)
        }
      } else {
        Text(second ? "Add an authenticator app" : "Turn on two-step sign-in").font(Typo.dialog)
        Text("Enter your password to start.").font(Typo.body).foregroundStyle(Ink.muted)
        SecureField("Your password", text: $password).textContentType(.password).onSubmit(start)
        if second { SecondStepFields(code: $proofCode, way: $way, hasApp: false, hasPasskey: hasPasskey, onSubmit: start) }
        if let error { Note(text: error) }
        HStack {
          Spacer()
          Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
          Button(action: start) { BusyLabel(busy, "Continue", "Checking…") }.buttonStyle(PrimaryButton())
            .disabled(busy || password.isEmpty || (second && !SecondStepFields.ready(proofCode, way))).keyboardShortcut(.defaultAction)
        }
      }
    }
    .padding(24).frame(width: 500)
    .background(Ink.card)
    .interactiveDismissDisabled(codes != nil) // the codes are shown once: closed only with "I Saved Them"
    .onAppear { way = SecondStepFields.start(hasApp: false, hasPasskey: hasPasskey) }
  }

  private func start() {
    guard let api = model.api, let me = model.me, !password.isEmpty, !busy, !second || SecondStepFields.ready(proofCode, way) else { return }
    busy = true; error = nil
    let pw = password
    Task {
      do {
        let s2 = try await secondStep(api, on: second, way: way, code: proofCode)
        setup = try await TwoFactor.setup(api: api, me: me, password: pw, second: s2); password = ""
      } catch { self.error = say(error); proofCode = "" }
      busy = false
    }
  }

  private func enable() {
    guard let api = model.api, TwoFactor.ready(code, recovery: false), !busy else { return }
    busy = true; error = nil
    Task {
      do {
        let c = try await TwoFactor.enable(api: api, code: code)
        setup = nil
        await model.refreshMe()
        if let c, !c.isEmpty { codes = c } else { dismiss() }
      } catch { self.error = say(error); code = "" }
      busy = false
    }
  }
}

/** The password and, while two-step sign-in is on, a second step: for turning it off, new recovery codes, removing the
 *  app or a passkey, and adding a passkey (which then opens the browser to make it). */
struct ProofSheet: View {
  enum Mode: Identifiable {
    case off, codes, removeApp, addKey
    case removeKey(Passkeys.Item)
    var id: String {
      switch self {
      case .off: return "off"
      case .codes: return "codes"
      case .removeApp: return "app"
      case .addKey: return "add"
      case .removeKey(let k): return "rm-" + k.id
      }
    }
  }
  let mode: Mode
  let on: Bool
  let hasApp: Bool
  let hasPasskey: Bool
  /** the passkey to remove is the account's only second step */
  var onlyStep = false
  let onCodes: ([String]) -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var code = ""
  @State private var way: CodeStepView.Way = .code
  @State private var name = "Passkey on this Mac"
  @State private var busy = false
  @State private var error: String?

  private var title: String {
    switch mode {
    case .off: return "Turn off two-step sign-in?"
    case .codes: return "Make new recovery codes?"
    case .removeApp: return "Remove the authenticator app?"
    case .addKey: return "Add a passkey"
    case .removeKey(let k): return "Remove \(k.name)?"
    }
  }
  private var detail: String {
    switch mode {
    case .off: return "Your password alone will sign in again. The authenticator app, your passkeys and your recovery codes are removed."
    case .codes: return "Your old recovery codes stop working."
    case .removeApp: return "A new sign-in then asks for a passkey, or a recovery code."
    case .addKey: return "Your browser opens on your server's address and makes the passkey there: in your password manager or on a security key. Your password is still needed at every new sign-in."
    case .removeKey: return onlyStep ? "It's your only second step: two-step sign-in turns off." : "It can't be used to sign in any more."
    }
  }
  private var action: String {
    switch mode {
    case .off: return "Turn Off"
    case .codes: return "Make New Codes"
    case .addKey: return "Continue"
    default: return "Remove"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(title).font(Typo.dialog)
      Text(detail).font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      if case .addKey = mode {
        VStack(alignment: .leading, spacing: 6) {
          FieldLabel(text: "Name")
          TextField("", text: $name).field()
        }
      }
      SecureField("Your password", text: $password).textContentType(.password)
      if on { SecondStepFields(code: $code, way: $way, hasApp: hasApp, hasPasskey: hasPasskey, onSubmit: go) }
      if let error { Note(text: error) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
        Button(action: go) { BusyLabel(busy, action, "Checking…") }.buttonStyle(PrimaryButton())
          .disabled(busy || password.isEmpty || (on && !SecondStepFields.ready(code, way))).keyboardShortcut(.defaultAction)
      }
    }
    .padding(24).frame(width: 460)
    .background(Ink.card)
    .onAppear { way = SecondStepFields.start(hasApp: hasApp, hasPasskey: hasPasskey) }
  }

  private func go() {
    guard let api = model.api, let me = model.me, !busy, !password.isEmpty, !on || SecondStepFields.ready(code, way) else { return }
    busy = true; error = nil
    let pw = password
    Task {
      do {
        let s2 = try await secondStep(api, on: on, way: way, code: code)
        switch mode {
        case .off:
          try await TwoFactor.disable(api: api, me: me, password: pw, second: s2)
          await model.refreshMe(); dismiss()
        case .codes:
          let codes = try await TwoFactor.newCodes(api: api, me: me, password: pw, second: s2)
          dismiss(); onCodes(codes)
        case .removeApp:
          try await TwoFactor.removeApp(api: api, me: me, password: pw, second: s2)
          dismiss()
        case .removeKey(let k):
          try await Passkeys.remove(api: api, me: me, password: pw, second: s2, id: k.id)
          await model.refreshMe(); dismiss()
        case .addKey:
          let options = try await Passkeys.beginAdd(api: api, me: me, password: pw, second: s2)
          let made = try await PasskeyBrowser.shared.run(server: api.base, op: "create", options: options)
          let codes = try await Passkeys.finishAdd(api: api, name: name, credential: made)
          await model.refreshMe(); dismiss()
          if let codes, !codes.isEmpty { onCodes(codes) }
        }
      } catch { self.error = say(error); code = "" }
      busy = false
    }
  }
}

// ---- devices ----

struct DevicesSection: View {
  @Environment(AppModel.self) private var model
  @State private var list: [Device]?
  @State private var error: String?
  @State private var ask: Device?
  @State private var askOthers = false
  @State private var busy = false

  var body: some View {
    Section_(title: "Devices", subtitle: "Where you're signed in. Sign out a device that is lost or not yours: it must sign in again, and deletes what it keeps of your library the next time it reaches the server.") {
      if let list {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(list) { d in
            HStack(alignment: .center, spacing: 10) {
              Image(systemName: icon(d)).foregroundStyle(Ink.teal).frame(width: 22)
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(d.name).font(Typo.label)
                  if d.current {
                    Text("This Mac").font(Typo.small.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                      .background(RoundedRectangle(cornerRadius: Radius.pill).fill(Ink.tealTint)).foregroundStyle(Ink.tealInk)
                  }
                }
                Text(detail(d)).font(Typo.caption).foregroundStyle(.secondary)
              }
              Spacer()
              if !d.current { Button("Sign Out…") { ask = d }.disabled(busy) }
            }
            .padding(.vertical, 8)
            if d.id != list.last?.id { Divider() }
          }
        }
        if list.contains(where: { !$0.current }) {
          Button("Sign Out All Other Devices…") { askOthers = true }.disabled(busy)
        }
      } else if error == nil {
        ProgressView().controlSize(.small)
      }
      if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
    }
    .task { await load() }
    .alert("Sign out \(ask?.name ?? "this device")?", isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } })) {
      Button("Sign Out", role: .destructive) { if let d = ask { run { try await Device.signOut(api: $0, id: d.id) } } }
      Button("Cancel", role: .cancel) {}
    } message: { Text("It must sign in again, and deletes what it keeps of your library the next time it reaches the server.") }
    .alert("Sign out all other devices?", isPresented: $askOthers) {
      Button("Sign Out", role: .destructive) { run { try await Device.signOutOthers(api: $0) } }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Every device except this Mac must sign in again, and deletes what it keeps of your library.") }
  }

  private func icon(_ d: Device) -> String {
    let n = d.device.lowercased()
    if n.contains("android") || n.contains("iphone") { return "iphone" }
    if n.contains("mac") { return "laptopcomputer" }
    return "globe"
  }

  private func detail(_ d: Device) -> String {
    let signedIn = Date(timeIntervalSince1970: TimeInterval(d.created_at)).formatted(date: .abbreviated, time: .omitted)
    let seen = d.current ? "active now" : "last active " + RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: TimeInterval(d.last_seen)), relativeTo: Date())
    return "Signed in \(signedIn) · \(seen)" + (d.indexer ? " · indexes your photos for search" : "")
  }

  private func load() async {
    guard let api = model.api else { return }
    do { list = try await Device.list(api: api); error = nil } catch { self.error = say(error) }
  }

  private func run(_ f: @escaping @Sendable (API) async throws -> Void) {
    guard let api = model.api else { return }
    busy = true; error = nil
    Task {
      do { try await f(api) } catch { self.error = say(error) }
      await load()
      busy = false
    }
  }
}

// ---- notices ----

/** The toolbar's bell: the account's notices (a new sign-in elsewhere, two-step sign-in turned off by an admin or
 *  changed on another device, the password used for a sign-in that wasn't finished) in a popover. The badge counts the
 *  ones newer than the newest the popover has shown (per account); opening it marks them all read. */
struct NoticeBell: View {
  @Environment(AppModel.self) private var model
  @State private var open = false

  var body: some View {
    let unread = model.unreadNotices
    Button { open.toggle() } label: {
      Label {
        Text("Notifications")
      } icon: {
        Image(systemName: unread > 0 ? "bell.badge" : "bell").symbolRenderingMode(unread > 0 ? .multicolor : .monochrome)
      }
    }
    .help(unread == 0 ? "Notifications" : unread == 1 ? "Notifications: 1 new" : "Notifications: \(unread) new")
    .accessibilityLabel(unread == 0 ? "Notifications" : unread == 1 ? "Notifications, 1 unread" : "Notifications, \(unread) unread")
    .popover(isPresented: $open, arrowEdge: .bottom) { NoticeInbox(open: $open) }
  }
}

/** Every notice, newest first: what happened, on which device and when, what to look at; each can be removed. */
struct NoticeInbox: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openSettings) private var openSettings
  @Binding var open: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Notifications").font(.headline).accessibilityAddTraits(.isHeader)
        Spacer()
        if !model.notices.isEmpty {
          Button("Remove All") { model.dismissAllNotices() }.buttonStyle(.link)
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 10)
      Divider()
      if model.notices.isEmpty {
        ContentUnavailableView("No Notifications", systemImage: "bell",
          description: Text("New sign-ins and changes to two-step sign-in show up here."))
          .frame(maxWidth: .infinity).padding(.vertical, 24)
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(model.notices) { n in
              row(n)
              if n.id != model.notices.last?.id { Divider().padding(.leading, 46) }
            }
          }
        }
        .frame(maxHeight: 420)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(width: 380)
    .onAppear { model.markNoticesRead() }
    // a notice that arrives while it is open is shown, so it is read too
    .onChange(of: model.notices) { model.markNoticesRead() }
  }

  private func row(_ n: Notice) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: n.reviewDevices ? "person.badge.shield.checkmark" : "exclamationmark.shield")
        .font(.title3).foregroundStyle(Ink.tealInk).frame(width: 22).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(NoticeAlerts.title(n)).font(.body.weight(.semibold))
        Text(n.text(time: n.date.formatted(date: .abbreviated, time: .shortened)))
          .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if let a = n.action {
          Button(a) {
            open = false
            model.settingsTab = "security"
            NSApp.activate()
            openSettings()
          }
          .buttonStyle(.link).padding(.top, 2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Button { model.dismiss(n) } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
        .buttonStyle(.borderless).foregroundStyle(.secondary)
        .help("Remove").accessibilityLabel("Remove \(NoticeAlerts.title(n))")
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .accessibilityElement(children: .contain)
  }
}
