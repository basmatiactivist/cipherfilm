// Settings › Administration (admins only): people with their usage, invites, storage limits, roles, disabling and
// deleting accounts, turning off someone's two-step sign-in, the explicit-search permission, the default limit, the
// server's state and the activity log; the web's Admin area (web/src/screens.tsx). The server checks every request
// (CipherfilmCore/Admin.swift); this tab only shows what it answers, and asks before anything that can't be undone.
import AppKit
import CipherfilmCore
import SwiftUI

private func say(_ error: Error) -> String { (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }

struct AdminSettings: View {
  @Environment(AppModel.self) private var model
  @State private var page = "people"
  @State private var accounts: Admin.Accounts?
  @State private var status: Admin.Status?
  @State private var activity: [Admin.Entry]?
  @State private var refused = false
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        if refused || !Admin.offered(model.me) {
          Text("Only administrators of this server can see this.").foregroundStyle(.secondary)
        } else {
          Picker("", selection: $page) {
            Text("People").tag("people")
            Text("Server").tag("server")
            Text("Activity").tag("activity")
          }
          .pickerStyle(.segmented).labelsHidden()
          if let p = status.flatMap({ Admin.backup($0).problem }), page != "server" {
            Note(text: p + " Details under Server.")
          }
          if let error { Text(error).font(Typo.caption).foregroundStyle(Ink.danger) }
          switch page {
          case "server": AdminServer(status: status, accounts: accounts, reload: reload)
          case "activity": AdminActivity(entries: activity)
          default: AdminPeople(accounts: accounts, reload: reload)
          }
        }
      }
      .padding(24)
    }
    .frame(height: 560)
    .task { await load() }
  }

  private func reload() { Task { await load() } }

  private func load() async {
    guard let api = model.api, Admin.offered(model.me) else { return }
    do {
      accounts = try await Admin.accounts(api: api)
      error = nil
    } catch {
      if Admin.noAccess(error) { refused = true; return }
      self.error = say(error)
    }
    status = try? await Admin.status(api: api)
    activity = try? await Admin.activity(api: api)
  }
}

// ---- people and invites ----

private enum Ask: Identifiable {
  case delete(Admin.User), disable(Admin.User), role(Admin.User), twoStep(Admin.User), revoke(Admin.Invite)
  var id: String {
    switch self {
    case .delete(let u): "delete" + u.id
    case .disable(let u): "disable" + u.id
    case .role(let u): "role" + u.id
    case .twoStep(let u): "2fa" + u.id
    case .revoke(let i): "revoke" + i.id
    }
  }
}

struct AdminPeople: View {
  let accounts: Admin.Accounts?
  let reload: () -> Void
  @Environment(AppModel.self) private var model
  @State private var email = ""
  @State private var gb = ""
  @State private var invite: Admin.NewInvite?
  @State private var copied = false
  @State private var busy = false
  @State private var inviteError: String?
  @State private var actError: String?
  @State private var ask: Ask?
  @State private var limitFor: Admin.User?

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      if let accounts {
        Text("\(Admin.summary(accounts.users)). Administrators can't see anyone's photos, album names or file names.")
          .font(Typo.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      } else {
        ProgressView().controlSize(.small)
      }
      Section_(title: "Invite someone", subtitle: "Cipherfilm doesn't send e-mail. Send the link yourself. It works once and expires after 7 days.") {
        TextField("Invited person's e-mail address", text: $email).textContentType(.emailAddress).autocorrectionDisabled()
        TextField("Storage limit in GB (optional)", text: $gb)
        Text("Leave the limit empty for the default (\(accounts.map { Admin.limit($0.default_quota_bytes) } ?? "…")). 0 means no limit.")
          .font(Typo.caption).foregroundStyle(.secondary)
        Button(busy ? "Creating…" : "Create Invite Link") { create() }
          .disabled(busy || email.trimmingCharacters(in: .whitespaces).isEmpty)
        if let inviteError { Text(inviteError).font(Typo.caption).foregroundStyle(Ink.danger) }
        if let invite {
          VStack(alignment: .leading, spacing: 8) {
            Text("Invite link for \(invite.email), valid until \(invite.expires.formatted(date: .abbreviated, time: .omitted)). It's shown only once.")
              .font(Typo.caption).fixedSize(horizontal: false, vertical: true)
            Text(invite.link).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
              .padding(8).frame(maxWidth: .infinity, alignment: .leading)
              .background(RoundedRectangle(cornerRadius: Radius.control).fill(Ink.paperDeep))
            HStack {
              Button(copied ? "Copied" : "Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(invite.link, forType: .string)
                copied = true
              }
              ShareLink("Share…", item: invite.link)
            }
          }
        }
      }
      if let invites = accounts?.invites, !invites.isEmpty {
        Divider()
        Section_(title: "Open invites") {
          ForEach(invites) { i in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(i.email).font(Typo.label)
                Text("Waiting, link valid until \(Date(timeIntervalSince1970: TimeInterval(i.expires_at)).formatted(date: .abbreviated, time: .omitted)). Limit: \(Admin.limit(i.quota_bytes)).")
                  .font(Typo.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Revoke…") { ask = .revoke(i) }
            }
          }
        }
      }
      if let users = accounts?.users {
        Divider()
        Section_(title: "Users", subtitle: "Explicit search is off for everyone: search leaves out explicit photos. Allow it for someone, and they can turn that filter off for themselves.") {
          if let actError { Text(actError).font(Typo.caption).foregroundStyle(Ink.danger) }
          VStack(alignment: .leading, spacing: 0) {
            ForEach(users) { u in
              row(u)
              if u.id != users.last?.id { Divider() }
            }
          }
        }
      }
    }
    .alert(title(ask), isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } }), presenting: ask) { a in
      Button(okLabel(a), role: { if case .role = a { return nil } else { return .destructive } }()) { confirm(a) }
      Button("Cancel", role: .cancel) {}
    } message: { a in Text(message(a)) }
    .sheet(item: $limitFor) { u in LimitSheet(title: "Storage limit for \(u.email)", current: u.quota_bytes) { bytes in
      try await act(.change(u.id, .limit(bytes)))
    } }
  }

  private func row(_ u: Admin.User) -> some View {
    let me = u.id == model.me?.user.id
    return HStack(alignment: .center, spacing: 10) {
      Image(systemName: u.isAdmin ? "shield" : u.isActive ? "person" : "nosign")
        .foregroundStyle(u.isActive ? Ink.teal : Ink.faint).frame(width: 22)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(u.email).font(Typo.label)
          if me { pill("you") }
          ForEach(Admin.badges(u), id: \.self) { pill($0, warn: $0 == "disabled") }
        }
        Text("\(Admin.lastSeen(u.last_login_at)) · \(Admin.usage(u))").font(Typo.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Menu("Manage") {
        // an admin may allow explicit search for themselves too, but not change their own role, status or limit
        Button(u.nsfw ? "Turn Off Explicit Search" : "Allow Explicit Search") { run(.change(u.id, .explicit(!u.nsfw))) }
        if !me {
          Button("Change Storage Limit…") { limitFor = u }
          if u.two_factor == true { Button("Turn Off Two-Step Sign-In…") { ask = .twoStep(u) } }
          Button(u.isAdmin ? "Make Regular User…" : "Make Admin…") { ask = .role(u) }
          if u.isActive { Button("Disable…") { ask = .disable(u) } } else { Button("Enable") { run(.change(u.id, .enabled(true))) } }
          Divider()
          Button("Delete…", role: .destructive) { ask = .delete(u) }
        }
      }
      .fixedSize()
    }
    .padding(.vertical, 8)
  }

  private func pill(_ s: String, warn: Bool = false) -> some View {
    Text(s).font(Typo.small.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
      .background(RoundedRectangle(cornerRadius: Radius.pill).fill(warn ? Ink.dangerTint : Ink.tealTint))
      .foregroundStyle(warn ? Ink.dangerInk : Ink.tealInk)
  }

  private func title(_ a: Ask?) -> String {
    switch a {
    case .delete(let u): "Delete \(u.email)?"
    case .disable(let u): "Disable \(u.email)?"
    case .role(let u): u.isAdmin ? "Make \(u.email) a regular user?" : "Make \(u.email) an administrator?"
    case .twoStep(let u): "Turn off two-step sign-in for \(u.email)?"
    case .revoke(let i): "Revoke the invite for \(i.email)?"
    case nil: ""
    }
  }

  private func message(_ a: Ask) -> String {
    switch a {
    case .delete: "Their account and everything they stored are deleted from the server right away. Nobody can bring them back. Their devices are signed out."
    case .disable: "They are signed out on every device and can't sign in until you enable the account again. Their photos stay."
    case .role(let u): u.isAdmin
      ? "They can no longer manage people, invites or the server. They get the default storage limit."
      : "They can invite and delete people, change limits and see the server's state, but not anyone's photos. Administrators have no storage limit."
    case .twoStep: "Their password alone signs in until they turn it on again. Do this only when you're sure it's them asking. Their devices tell them."
    case .revoke: "The link stops working. You can invite them again later."
    }
  }

  private func okLabel(_ a: Ask) -> String {
    switch a {
    case .delete: "Delete"
    case .disable: "Disable"
    case .role(let u): u.isAdmin ? "Make Regular User" : "Make Admin"
    case .twoStep: "Turn Off"
    case .revoke: "Revoke"
    }
  }

  private func confirm(_ a: Ask) {
    switch a {
    case .delete(let u): run(.delete(u.id))
    case .disable(let u): run(.change(u.id, .enabled(false)))
    case .role(let u): run(.change(u.id, .admin(!u.isAdmin)))
    case .twoStep(let u): run(.resetTwoStep(u.id))
    case .revoke(let i): run(.revokeInvite(i.id))
    }
  }

  private func act(_ a: Admin.Action) async throws {
    guard let api = model.api else { return }
    try await Admin.run(api: api, a)
    reload()
  }

  /** A row action that fails says so instead of doing nothing. */
  private func run(_ a: Admin.Action) {
    actError = nil
    Task {
      do { try await act(a) } catch { actError = say(error); reload() }
    }
  }

  private func create() {
    guard let api = model.api, !busy else { return }
    busy = true; inviteError = nil; copied = false
    let e = email, g = gb
    Task {
      do {
        invite = try await Admin.invite(api: api, email: e, gb: g)
        email = ""; gb = ""
        reload()
      } catch { inviteError = say(error) }
      busy = false
    }
  }
}

/** A storage limit in GB, checked here and then by the server. */
struct LimitSheet: View {
  let title: String
  let current: Int64
  let save: (Int64) async throws -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var gb = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(title).font(Typo.dialog)
      TextField("Limit in GB (0 = no limit)", text: $gb).onSubmit(go)
      if let error { Note(text: error) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
        Button(busy ? "Saving…" : "Save", action: go).keyboardShortcut(.defaultAction).disabled(busy)
      }
    }
    .padding(24).frame(width: 420)
    .onAppear { gb = Admin.gbText(current) }
  }

  private func go() {
    guard !busy else { return }
    error = nil
    let bytes: Int64
    do { bytes = try Admin.parseGB(gb) ?? 0 } catch { self.error = say(error); return }
    busy = true
    Task {
      do { try await save(bytes); dismiss() } catch { self.error = say(error) }
      busy = false
    }
  }
}

// ---- server ----

struct AdminServer: View {
  let status: Admin.Status?
  let accounts: Admin.Accounts?
  let reload: () -> Void
  @Environment(AppModel.self) private var model
  @State private var editing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      if let accounts {
        Section_(title: "Default storage limit", subtitle: "New people get \(Admin.limit(accounts.default_quota_bytes)) unless the invite says otherwise. People who already joined keep their limit.") {
          Button("Change Default…") { editing = true }
        }
        Divider()
      }
      Section_(title: "Server") {
        if let s = status {
          if s.disk_total_bytes > 0 {
            ProgressView(value: Double(s.disk_total_bytes - s.disk_free_bytes), total: Double(s.disk_total_bytes))
              .tint(Double(s.disk_free_bytes) / Double(s.disk_total_bytes) < 0.1 ? Ink.danger : Ink.teal)
          }
          LabeledContent("Disk free", value: "\(Admin.size(s.disk_free_bytes)) of \(Admin.size(s.disk_total_bytes))")
          LabeledContent("Cipherfilm data", value: Admin.size(s.data_bytes))
          LabeledContent("Signed-in devices", value: String(s.active_sessions))
          LabeledContent("Version", value: s.version ?? "unknown")
          LabeledContent("Running for", value: Admin.uptime(s.uptime_seconds))
          let b = Admin.backup(s)
          LabeledContent("Off-site backup") {
            Text(b.text).foregroundStyle(b.problem == nil ? Color.secondary : Ink.danger).multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
          }
          LabeledContent("Database snapshot") {
            Text(s.last_backup_at > 0 ? Date(timeIntervalSince1970: TimeInterval(s.last_backup_at)).formatted(date: .abbreviated, time: .shortened) : "None yet. Written by scripts/backup.sh or the nightly backup.")
              .foregroundStyle(.secondary).multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
          }
        } else {
          ProgressView().controlSize(.small)
        }
      }
    }
    .sheet(isPresented: $editing) {
      LimitSheet(title: "Default storage limit", current: accounts?.default_quota_bytes ?? 0) { bytes in
        guard let api = model.api else { return }
        try await Admin.run(api: api, .defaultLimit(bytes))
        reload()
      }
    }
  }
}

// ---- activity ----

struct AdminActivity: View {
  let entries: [Admin.Entry]?
  @Environment(AppModel.self) private var model

  var body: some View {
    Section_(title: "Activity") {
      if let entries {
        if entries.isEmpty {
          Text("Nothing yet. Invites, role and limit changes, and removals show up here.").font(Typo.caption).foregroundStyle(.secondary)
        }
        ForEach(Array(Admin.byDay(entries).enumerated()), id: \.offset) { _, group in
          Text(group.day).font(Typo.label).padding(.top, 6)
          ForEach(Array(group.entries.enumerated()), id: \.offset) { _, e in
            let d = Admin.describe(e, me: model.me?.user.email ?? "")
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text(Date(timeIntervalSince1970: TimeInterval(e.at)).formatted(date: .omitted, time: .shortened))
                .font(Typo.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
              Image(systemName: d.symbol).foregroundStyle(d.warn ? Ink.danger : Ink.faint).frame(width: 18)
              Text(d.text).font(Typo.caption).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      } else {
        ProgressView().controlSize(.small)
      }
    }
  }
}
