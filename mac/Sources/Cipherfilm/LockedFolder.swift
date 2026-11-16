// The locked folder (CipherfilmCore/Folders.swift): photos and videos moved here appear nowhere else in the app, and the
// folder asks who is there every time it opens, even while the library is unlocked: the fingerprint where this Mac has
// a sensor with a finger set up, else (or when the person prefers) the account password, checked on this Mac only (the
// key it makes must be the library's master key; nothing is sent). Its items reach memory only after the check, and
// leave it again, with their decrypted pictures, when the folder is left or the app locks (AppModel.leaveLocked, wipe).
// Its pictures are never cached on disk (Vault.picture). Delete here deletes for good: the trash never shows them.
import CipherfilmCore
import LocalAuthentication
import SwiftUI

enum LockedGate {
  /** A fingerprint can be asked for on this Mac. */
  static var fingerprintAvailable: Bool {
    var e: NSError?
    return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
  }

  /** true when the finger was accepted, false when the person cancelled; throws when it failed otherwise. */
  static func fingerprint() async throws -> Bool {
    let ctx = LAContext()
    do {
      try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "open your locked folder")
      return true
    } catch let e as LAError where [.userCancel, .appCancel, .systemCancel, .userFallback].contains(e.code) {
      return false
    }
  }

  /** The account password, checked here as the unlock does: the key it opens must be the one the library is open with. */
  static func password(_ password: String, me: Me, vault: Vault) async throws {
    var key = try await Task.detached(priority: .userInitiated) { try Account.unlock(me: me, password: password) }.value
    defer { Sodium.memzero(&key) }
    guard Sodium.equal(key, try vault.masterKey()) else { throw APIError(status: -1, message: "That password isn't right.") }
  }
}

struct LockedFolderView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Bindable var selection: Selection

  var body: some View {
    VStack(spacing: 0) {
      if model.lockedOpen {
        let items = model.lockedItems
        HStack(alignment: .bottom) {
          PageTitle(title: "Locked Folder", subtitle: items.isEmpty ? "Shown nowhere else. Asks for you every time it opens." : "\(items.count) item\(items.count == 1 ? "" : "s") · shown nowhere else")
          Button { model.leaveLocked(); nav.go(.photos) } label: { Label("Close Folder", systemImage: "lock") }
            .buttonStyle(SecondaryButton()).padding(.trailing, 28).help("Close the locked folder; it asks for you again next time")
        }
        if items.isEmpty {
          Spacer()
          EmptyState(icon: "lock.square", title: "Nothing locked yet", text: "Right-click photos or videos and choose Move to Locked Folder. They then show up only here, not in Photos, albums, search, people, the map or the export folder.")
          Spacer()
        } else {
          PhotoGrid(items: items, grouping: .none, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
        }
      } else {
        LockedGateView()
      }
    }
    // left: another screen, a search, the window closing. The next visit asks again.
    .onDisappear { model.leaveLocked() }
  }
}

/** The check in front of the locked folder. */
struct LockedGateView: View {
  @Environment(AppModel.self) private var model
  @State private var password = ""
  @State private var usePassword = !LockedGate.fingerprintAvailable
  @State private var error: String?
  @State private var busy = false
  /** the check in progress: cancelled when the gate goes (another screen, a search); openLocked also refuses it then */
  @State private var check: Task<Void, Never>?

  var body: some View {
    Spacer()
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Image(systemName: "lock.fill").font(.system(size: 20)).foregroundStyle(Ink.teal)
          .frame(width: 44, height: 44).background(Circle().fill(Ink.tealTint))
        VStack(alignment: .leading, spacing: 2) {
          Text("Locked Folder").font(Typo.dialog).foregroundStyle(Ink.ink)
          Text("Confirm it's you to open it, every time.").font(Typo.body).foregroundStyle(Ink.muted)
        }
      }
      if usePassword {
        VStack(alignment: .leading, spacing: 6) {
          FieldLabel(text: "Password")
          SecureField("", text: $password).field().onSubmit(checkPassword)
        }
      }
      if let error { Note(text: error) }
      if usePassword {
        Button(action: checkPassword) { BusyLabel(busy, "Open", "Checking…").frame(maxWidth: .infinity) }
          .buttonStyle(PrimaryButton()).disabled(busy || password.isEmpty).keyboardShortcut(.defaultAction)
        if LockedGate.fingerprintAvailable {
          Button("Use Your Fingerprint Instead") { usePassword = false; error = nil; password = "" }.buttonStyle(TextLink()).font(Typo.caption)
        }
      } else {
        Button(action: checkFingerprint) { Label("Open with Your Fingerprint", systemImage: "touchid").frame(maxWidth: .infinity) }
          .buttonStyle(PrimaryButton()).disabled(busy).keyboardShortcut(.defaultAction)
        Button("Use Your Password Instead") { usePassword = true; error = nil }.buttonStyle(TextLink()).font(Typo.caption)
      }
      Text("What you move here is shown nowhere else in the app and isn't kept on this Mac's disk.").font(Typo.caption).foregroundStyle(Ink.faint)
    }
    .padding(28).frame(width: 400)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
    .frame(maxWidth: .infinity)
    .task { if !usePassword && NSApp.isActive { checkFingerprint() } }
    .onDisappear { password = ""; check?.cancel(); check = nil; busy = false }
    Spacer()
  }

  private func checkFingerprint() {
    guard !busy else { return }
    busy = true; error = nil
    let visit = model.lockedVisit
    check = Task {
      do { if try await LockedGate.fingerprint(), !Task.isCancelled { await model.openLocked(visit: visit) } }
      catch { if !Task.isCancelled { self.error = "Your fingerprint wasn't recognized. Try again or use your password." } }
      busy = false
    }
  }

  private func checkPassword() {
    guard !busy, !password.isEmpty, let me = model.me, let vault = model.vault else { return }
    busy = true; error = nil
    let pw = password
    let visit = model.lockedVisit
    check = Task {
      do {
        try await LockedGate.password(pw, me: me, vault: vault); password = ""
        if !Task.isCancelled { await model.openLocked(visit: visit) }
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
      busy = false
    }
  }
}
