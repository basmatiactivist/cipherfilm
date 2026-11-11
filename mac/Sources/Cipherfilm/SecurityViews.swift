// Settings › Security: two-step sign-in (server/twofactor.go) and the account's signed-in devices; and the banner that
// shows a notice once (a new sign-in elsewhere, two-step sign-in turned off by an admin).
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

// ---- two-step sign-in ----

struct TwoFactorSection: View {
  @Environment(AppModel.self) private var model
  @State private var status: TwoFactor.Status?
  @State private var error: String?
  @State private var setup = false
  @State private var action: ProofSheet.Mode?
  @State private var shownCodes: [String]?

  var body: some View {
    Section_(title: "Two-step sign-in", subtitle: "After your password, signing in on a new device also asks for a code from an authenticator app on your phone. Unlocking this Mac doesn't.") {
      if let s = status {
        if s.enabled {
          Label("On. \(s.recovery_codes_left) of 10 recovery codes left.", systemImage: "checkmark.shield").font(Typo.caption).foregroundStyle(Ink.ok)
          if s.recovery_codes_left <= 3 { Text("Make new recovery codes soon: each one works once.").font(Typo.caption).foregroundStyle(Ink.danger) }
          HStack {
            Button("New Recovery Codes…") { action = .codes }
            Button("Turn Off…") { action = .off }
          }
        } else {
          Text("Off. Your password alone signs in.").font(Typo.caption).foregroundStyle(.secondary)
          Button("Turn On…") { setup = true }
        }
      } else if error == nil {
        ProgressView().controlSize(.small)
      }
      if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
    }
    .task { await load() }
    .sheet(isPresented: $setup, onDismiss: { Task { await load() } }) { TwoFactorSetupSheet().environment(model) }
    .sheet(item: $action, onDismiss: { Task { await load() } }) { m in
      ProofSheet(mode: m) { codes in shownCodes = codes }.environment(model)
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
    do { status = try await TwoFactor.status(api: api); error = nil } catch { self.error = say(error) }
    await model.refreshMe()
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
      Text("If you lose your phone, each of these signs in once instead of a code. Keep them somewhere safe, like a password manager. They are shown only now.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 6) {
        ForEach(codes, id: \.self) { Text($0).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
      }
      .padding(12)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Ink.paperDeep))
      Button(copied ? "Copied" : "Copy Codes") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(codes.joined(separator: "\n"), forType: .string)
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

/** Turning it on: the password, then the secret (QR and text) and a code from it, then the recovery codes. */
struct TwoFactorSetupSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var setup: TwoFactor.Setup?
  @State private var code = ""
  @State private var codes: [String]?
  @State private var busy = false
  @State private var error: String?
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let codes {
        RecoveryCodesView(codes: codes, fresh: true)
        Note(text: "Two-step sign-in is on.", ok: true)
        HStack { Spacer(); Button("I Saved Them") { dismiss() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction) }
      } else if let setup {
        Text("Add Cipherfilm to your authenticator app").font(Typo.dialog)
        Text("Scan this with an authenticator app (such as 2FAS, Aegis, Google Authenticator or 1Password), or type the key in.")
          .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
        HStack(alignment: .top, spacing: 16) {
          QRImage(text: setup.uri)
          VStack(alignment: .leading, spacing: 8) {
            FieldLabel(text: "Key")
            Text(TwoFactor.grouped(setup.secret)).font(.system(.body, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Button(copied ? "Copied" : "Copy Key") {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(setup.secret, forType: .string)
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
        Text("Turn on two-step sign-in").font(Typo.dialog)
        Text("Enter your password to start.").font(Typo.body).foregroundStyle(Ink.muted)
        SecureField("Your password", text: $password).textContentType(.password).onSubmit(start)
        if let error { Note(text: error) }
        HStack {
          Spacer()
          Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
          Button(action: start) { BusyLabel(busy, "Continue", "Checking…") }.buttonStyle(PrimaryButton())
            .disabled(busy || password.isEmpty).keyboardShortcut(.defaultAction)
        }
      }
    }
    .padding(24).frame(width: 500)
    .background(Ink.card)
    .interactiveDismissDisabled(codes != nil) // the codes are shown once: closed only with "I Saved Them"
  }

  private func start() {
    guard let api = model.api, let me = model.me, !password.isEmpty, !busy else { return }
    busy = true; error = nil
    let pw = password
    Task {
      do { setup = try await TwoFactor.setup(api: api, me: me, password: pw); password = "" } catch { self.error = say(error) }
      busy = false
    }
  }

  private func enable() {
    guard let api = model.api, TwoFactor.ready(code, recovery: false), !busy else { return }
    busy = true; error = nil
    Task {
      do { codes = try await TwoFactor.enable(api: api, code: code); setup = nil; await model.refreshMe() } catch { self.error = say(error); code = "" }
      busy = false
    }
  }
}

/** Password and a code (or a recovery code), for turning two-step sign-in off or making new recovery codes. */
struct ProofSheet: View {
  enum Mode: String, Identifiable { case off, codes; var id: String { rawValue } }
  let mode: Mode
  let onCodes: ([String]) -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var code = ""
  @State private var recovery = false
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(mode == .off ? "Turn off two-step sign-in?" : "Make new recovery codes?").font(Typo.dialog)
      Text(mode == .off ? "Your password alone will sign in again. Your recovery codes stop working." : "Your old recovery codes stop working.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      SecureField("Your password", text: $password).textContentType(.password)
      VStack(alignment: .leading, spacing: 6) {
        FieldLabel(text: recovery ? "Recovery code" : "Code from your authenticator app")
        if recovery {
          TextField("xxxx-xxxx-xxxx-xxxx", text: $code).field().autocorrectionDisabled().onSubmit(go)
        } else {
          TextField("123456", text: $code).field().textContentType(.oneTimeCode).onSubmit(go)
        }
        Button(recovery ? "Use the authenticator app" : "Use a recovery code") { recovery.toggle(); code = "" }.buttonStyle(TextLink()).font(Typo.caption)
      }
      if let error { Note(text: error) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction).disabled(busy)
        Button(action: go) { BusyLabel(busy, mode == .off ? "Turn Off" : "Make New Codes", "Checking…") }.buttonStyle(PrimaryButton())
          .disabled(busy || password.isEmpty || !TwoFactor.ready(code, recovery: recovery)).keyboardShortcut(.defaultAction)
      }
    }
    .padding(24).frame(width: 460)
    .background(Ink.card)
  }

  private func go() {
    guard let api = model.api, let me = model.me, !busy, !password.isEmpty, TwoFactor.ready(code, recovery: recovery) else { return }
    busy = true; error = nil
    let pw = password, c = code
    Task {
      do {
        if mode == .off {
          try await TwoFactor.disable(api: api, me: me, password: pw, code: c)
          await model.refreshMe()
          dismiss()
        } else {
          let codes = try await TwoFactor.newCodes(api: api, me: me, password: pw, code: c)
          dismiss()
          onCodes(codes)
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

/** The newest notice, once, over the library: a new sign-in elsewhere, two-step sign-in turned off by an admin, or the
 *  password used for a sign-in that wasn't finished. */
struct NoticeBanner: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    if let n = model.notices.first {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: n.reviewDevices ? "person.badge.shield.checkmark" : "exclamationmark.shield").foregroundStyle(Ink.tealInk)
        Text(n.text(time: n.date.formatted(date: .abbreviated, time: .shortened))).font(Typo.label).foregroundStyle(Ink.ink)
          .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        if n.opensSettings {
          Button(n.reviewDevices ? "Review Devices" : "Open Settings") {
            model.settingsTab = "security"
            NSApp.activate()
            openSettings()
          }.buttonStyle(SecondaryButton())
        }
        Button { model.dismiss(n) } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Dismiss").accessibilityLabel("Dismiss")
      }
      .padding(Space.s3)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Ink.tealTint))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Ink.teal, lineWidth: 1))
      .padding(.horizontal, 16).padding(.top, 10)
    }
  }
}
