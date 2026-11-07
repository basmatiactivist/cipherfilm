// Signed out: which server, then the account; signed in but locked: the password once more for the keys.
import CipherfilmCore
import SwiftUI

/** The signed-out page: a centred 420 px card with a serif title, on paper. */
struct AuthCard<Content: View>: View {
  let title: String
  let subtitle: String?
  var server: String = ""
  @ViewBuilder let content: Content

  var body: some View {
    VStack(spacing: 22) {
      HStack(spacing: 10) {
        Mark(size: 28)
        Text("Cipherfilm").font(Typo.dialog)
      }
      VStack(alignment: .leading, spacing: 16) {
        Text(title).font(Typo.auth)
        if !server.isEmpty { ServerPill(name: server) }
        if let subtitle { Text(subtitle).font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true) }
        content
      }
      .padding(.horizontal, 26).padding(.top, 26).padding(.bottom, 24)
      .frame(width: 420)
      .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
      Label("End-to-end encrypted. Your server never sees your photos.", systemImage: "lock.fill")
        .font(Typo.caption).foregroundStyle(Ink.faint)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Ink.paper)
  }
}

/** The server this window talks to, so a person with two Cipherfilms always knows which one this is. */
struct ServerPill: View {
  let name: String
  var body: some View {
    Label(name, systemImage: "server.rack")
      .font(Typo.caption.weight(.semibold)).foregroundStyle(Ink.tealInk)
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(RoundedRectangle(cornerRadius: Radius.pill).fill(Ink.tealTint))
      .help("Cipherfilm server: \(name)")
  }
}

struct FieldLabel: View {
  let text: String
  var body: some View { Text(text).font(Typo.label).foregroundStyle(Ink.ink) }
}

struct ServerView: View {
  @Environment(AppModel.self) private var model
  @State private var address = ""
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    AuthCard(title: "Your server", subtitle: "Your Cipherfilm address, as you open it in the browser.") {
      VStack(alignment: .leading, spacing: 6) {
        FieldLabel(text: "Address")
        TextField("photos.example.org", text: $address).field().onSubmit(go)
      }
      if let error { Note(text: error) }
      Button(action: go) { BusyLabel(busy, "Continue", "Checking…").frame(maxWidth: .infinity) }
        .buttonStyle(PrimaryButton()).disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
        .keyboardShortcut(.defaultAction)
    }
  }

  private func go() {
    busy = true; error = nil
    Task {
      do { try await model.chooseServer(address) } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

struct SignInView: View {
  @Environment(AppModel.self) private var model
  @State private var email = ""
  @State private var password = ""
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    AuthCard(title: "Sign in", subtitle: nil, server: model.serverName) {
      if let n = model.notice { Note(text: n) }
      VStack(alignment: .leading, spacing: 6) {
        FieldLabel(text: "E-mail")
        TextField("", text: $email).field().textContentType(.username)
      }
      VStack(alignment: .leading, spacing: 6) {
        FieldLabel(text: "Password")
        SecureField("", text: $password).field().textContentType(.password).onSubmit(go)
      }
      if let error { Note(text: error) }
      Button(action: go) { BusyLabel(busy, "Sign in", "Signing in…").frame(maxWidth: .infinity) }
        .buttonStyle(PrimaryButton()).disabled(busy || email.isEmpty || password.isEmpty)
        .keyboardShortcut(.defaultAction)
      Button("Use another server") { model.forgetServer() }.buttonStyle(TextLink()).font(Typo.caption)
    }
  }

  private func go() {
    busy = true; error = nil
    Task {
      do { try await model.login(email: email, password: password); password = "" } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

struct UnlockView: View {
  @Environment(AppModel.self) private var model
  @State private var password = ""
  @State private var error: String?
  @State private var busy = false
  @State private var signOut = false

  var body: some View {
    AuthCard(title: "Unlock your library", subtitle: model.me.map { "Signed in as \($0.user.email). Your password stays on this Mac." }, server: model.serverName) {
      VStack(alignment: .leading, spacing: 6) {
        FieldLabel(text: "Password")
        SecureField("", text: $password).field().onSubmit(go)
      }
      if let error { Note(text: error) }
      Button(action: go) { BusyLabel(busy, "Unlock", "Unlocking…").frame(maxWidth: .infinity) }
        .buttonStyle(PrimaryButton()).disabled(busy || password.isEmpty)
        .keyboardShortcut(.defaultAction)
      if model.touchID {
        Button(action: touch) { Label("Unlock with Touch ID", systemImage: "touchid").frame(maxWidth: .infinity) }
          .buttonStyle(SecondaryButton()).disabled(busy)
      }
      if model.watcher.running || model.settings.watchOn {
        Text("Watched folders keep uploading while the library is locked.").font(Typo.caption).foregroundStyle(Ink.muted)
      }
      Button("Sign out") { signOut = true }.buttonStyle(TextLink()).font(Typo.caption)
    }
    .sheet(isPresented: $signOut) { SignOutSheet() }
    .task { if model.touchID && NSApp.isActive { touch() } }
  }

  private func go() {
    busy = true; error = nil
    Task {
      do { try await model.unlock(password: password); password = "" } catch { self.error = error.localizedDescription }
      busy = false
    }
  }

  private func touch() {
    busy = true; error = nil
    Task {
      do { _ = try await model.unlockWithTouchID() } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

struct SignOutSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var deleteExport = false
  @State private var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Sign out of Cipherfilm?").font(Typo.dialog)
      Text("This Mac's cache, search index and export and watched-folder settings for this account are deleted. Your library on the server stays.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      if model.settings.exportPath != nil {
        Toggle("Also move the exported copies to the Trash", isOn: $deleteExport).toggleStyle(.checkbox)
        Text("Only unchanged files. Edited files stay.").font(Typo.caption).foregroundStyle(Ink.faint)
      }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction)
        Button {
          busy = true
          Task { await model.signOut(deleteExport: deleteExport); dismiss() }
        } label: { BusyLabel(busy, "Sign out", "Signing out…") }.buttonStyle(PrimaryButton()).disabled(busy)
      }
    }
    .padding(24).frame(width: 440)
    .background(Ink.card)
  }
}

/** After the first unlock: keep working in the menu bar and open at login? */
struct AgentQuestion: View {
  @Environment(AppModel.self) private var model
  @State private var search = true
  @State private var explicit = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) { Mark(size: 26); Text("Keep Cipherfilm running?").font(Typo.dialog) }
      Text("Cipherfilm can open at login and stay in the menu bar when you close the window, to keep exporting, uploading watched folders and indexing.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      if !model.settings.searchAsked {
        Toggle(isOn: $search) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Search what and who is in your photos").font(Typo.label)
            Text(model.search.downloadSize(explicit ? .laion : .mobileclip, faces: model.settings.faces).map { "Runs on this Mac. Downloads \($0) once from Hugging Face. Hugging Face sees this Mac's IP address, nothing of your photos." } ?? "Runs on this Mac. The models are already here.").font(Typo.caption).foregroundStyle(Ink.muted)
          }
        }.toggleStyle(.checkbox)
        // only for people an admin allowed explicit search: which model, before anything is downloaded
        if model.me?.user.nsfw == true && search {
          Picker("Model", selection: $explicit) {
            Text("Standard search (MobileCLIP, \(model.search.downloadSize(.mobileclip, faces: model.settings.faces) ?? "already on this Mac"))").tag(false)
            Text("Explicit search (LAION, \(model.search.downloadSize(.laion, faces: model.settings.faces) ?? "already on this Mac")): also understands explicit content").tag(true)
          }
          .pickerStyle(.radioGroup).labelsHidden().font(Typo.caption).padding(.leading, 20)
        }
      }
      Text("You can change this any time in Settings.").font(Typo.caption).foregroundStyle(Ink.faint)
      HStack {
        Spacer()
        Button("Not now") { askSearch(); model.agent.answer(false) }.buttonStyle(SecondaryButton())
        Button("Open at Login") { askSearch(); model.agent.answer(true) }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
      }
    }
    .padding(24).frame(width: 460)
    .background(Ink.card)
  }

  private func askSearch() {
    guard !model.settings.searchAsked else { return }
    if search { model.turnOnSearch(explicit: model.me?.user.nsfw == true ? explicit : nil) } else { model.settings.searchAsked = true }
  }
}
