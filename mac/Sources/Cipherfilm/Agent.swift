// The Mac keeps working with the window closed: Cipherfilm stays in the menu bar (no Dock icon then) and, if the person
// agrees, opens at login (SMAppService). Export, watched folders and indexing run there.
import AppKit
import Observation
import Security
import ServiceManagement

@MainActor @Observable
final class Agent {
  /** Stay in the menu bar when the last window closes. */
  var keepRunning: Bool = UserDefaults.standard.object(forKey: "keepRunning") as? Bool ?? true {
    didSet { UserDefaults.standard.set(keepRunning, forKey: "keepRunning") }
  }
  var openAtLogin = false
  var loginProblem: String?
  /** the question after the first unlock */
  var askNow = false
  /** opens the library window from outside a view (a second launch asking for it) */
  @ObservationIgnored var opener: OpenWindowAction?
  /** opens Settings from outside a view (a click on a notice's notification) */
  @ObservationIgnored var settingsOpener: OpenSettingsAction?

  static let showNote = Notification.Name("app.cipherfilm.show-window")

  func setUp() {
    openAtLogin = SMAppService.mainApp.status == .enabled
    NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in AppModel.shared.agent.windowsChanged(closing: true) }
    }
    NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in AppModel.shared.agent.windowsChanged(closing: false) }
    }
    // started at login: no window, just the menu bar
    if Self.launchedAtLogin { NSApp.setActivationPolicy(.accessory) }
    // a second launch (from the Downloads folder, or a copy macOS runs from a quarantine location) asks for the window
    DistributedNotificationCenter.default().addObserver(forName: Self.showNote, object: Bundle.main.bundleIdentifier, queue: .main) { _ in
      Task { @MainActor in
        let a = AppModel.shared.agent
        if let open = a.opener { a.showWindow(open) } else { NSApp.setActivationPolicy(.regular); NSApp.activate() }
      }
    }
  }

  static var launchedAtLogin: Bool {
    guard let e = NSAppleEventManager.shared().currentAppleEvent else { return false }
    return e.eventID == kAEOpenApplication && e.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
  }

  func unlocked() {
    if !AppModel.shared.settings.agentAsked { askNow = true }
  }

  func answer(_ yes: Bool) {
    askNow = false
    AppModel.shared.settings.agentAsked = true
    keepRunning = yes
    setOpenAtLogin(yes)
  }

  func setOpenAtLogin(_ on: Bool) {
    loginProblem = nil
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      loginProblem = "macOS didn't allow it: \(error.localizedDescription). You can add Cipherfilm under System Settings › General › Login Items."
    }
    openAtLogin = SMAppService.mainApp.status == .enabled
    if SMAppService.mainApp.status == .requiresApproval { loginProblem = "Allow Cipherfilm under System Settings › General › Login Items."; SMAppService.openSystemSettingsLoginItems() }
  }

  private func windowsChanged(closing: Bool) {
    DispatchQueue.main.async {
      let visible = NSApp.windows.contains { $0.isVisible && $0.canBecomeMain && !($0.className.contains("MenuBarExtra")) && $0.level == .normal }
      if visible { if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) } }
      else if self.keepRunning { NSApp.setActivationPolicy(.accessory) }
    }
  }

  /** Settings › Security, in front (a click on a notice's notification, Notifier.swift). */
  func openSecurity() {
    AppModel.shared.settingsTab = "security"
    NSApp.activate()
    settingsOpener?()
  }

  func showWindow(_ open: OpenWindowAction) {
    NSApp.setActivationPolicy(.regular)
    open(id: "main")
    NSApp.activate()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  /** One Cipherfilm at a time (two would upload, export and index the same things twice): a second launch shows the
   *  running one's window and quits before it starts anything. Only for a running app signed like this one: another
   *  app that merely claims the bundle id doesn't keep Cipherfilm from starting. */
  func applicationWillFinishLaunching(_ notification: Notification) {
    guard let id = Bundle.main.bundleIdentifier else { return }
    let me = ProcessInfo.processInfo.processIdentifier
    guard let other = NSRunningApplication.runningApplications(withBundleIdentifier: id)
      .first(where: { $0.processIdentifier != me && !$0.isTerminated && Self.signedLikeThis($0.processIdentifier) }) else { return }
    DistributedNotificationCenter.default().postNotificationName(Agent.showNote, object: id, userInfo: nil, deliverImmediately: true)
    other.activate()
    exit(0)
  }

  /** The process at pid has a valid signature with this app's signing identifier and, when this build is signed by a
   *  team, that team's certificate. */
  static func signedLikeThis(_ pid: pid_t) -> Bool {
    var mine: SecCode?, other: SecCode?
    guard SecCodeCopySelf([], &mine) == errSecSuccess, let mine,
          SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &other) == errSecSuccess, let other else { return false }
    var st: SecStaticCode?, info: CFDictionary?
    guard SecCodeCopyStaticCode(mine, [], &st) == errSecSuccess, let st,
          SecCodeCopySigningInformation(st, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let d = info as? [String: Any], let ident = d[kSecCodeInfoIdentifier as String] as? String,
          !ident.contains("\"") else { return false }
    var rule = "identifier \"\(ident)\""
    if let team = d[kSecCodeInfoTeamIdentifier as String] as? String, !team.contains("\"") {
      rule = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and " + rule
    }
    var req: SecRequirement?
    guard SecRequirementCreateWithString(rule as CFString, [], &req) == errSecSuccess, let req else { return false }
    return SecCodeCheckValidity(other, [], req) == errSecSuccess
  }

  /** Set by Quit in the menu-bar panel: then the app really ends. */
  @MainActor static var quitting = false

  /** ⌘Q closes the window and keeps Cipherfilm in the menu bar (when that is on); Quit in the menu-bar panel, logging
   *  out and shutting down end it. */
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    MainActor.assumeIsolated {
      let ev = NSAppleEventManager.shared().currentAppleEvent
      let systemQuit = ev?.eventID == kAEQuitApplication && ev?.attributeDescriptor(forKeyword: kAEQuitReason) != nil
      guard AppModel.shared.agent.keepRunning, !AppDelegate.quitting, !systemQuit else { return .terminateNow }
      for w in NSApp.windows where w.isVisible && w.level == .normal && w.canBecomeMain { w.close() }
      NSApp.setActivationPolicy(.accessory)
      return .terminateCancel
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    MainActor.assumeIsolated { !AppModel.shared.agent.keepRunning }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
}

import SwiftUI
