// macOS notifications when background work finishes (uploads, watched folders, the first full export or index).
// They say how many, never names or contents. Settings › General turns them off.
import AppKit
import CipherfilmCore
import Foundation
@preconcurrency import UserNotifications

enum Notifier {
  static var enabled: Bool {
    get { UserDefaults.standard.object(forKey: "notifications") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "notifications") }
  }

  static func post(_ title: String, _ body: String) {
    guard enabled, Bundle.main.bundleIdentifier != nil else { return }
    let c = UNUserNotificationCenter.current()
    c.requestAuthorization(options: [.alert, .sound]) { ok, _ in
      guard ok else { return }
      let n = UNMutableNotificationContent()
      n.title = title
      n.body = body
      c.add(UNNotificationRequest(identifier: UUID().uuidString, content: n, trigger: nil))
    }
  }
}

/**
 * Account notices (a new sign-in elsewhere, two-step sign-in turned off or changed, an unfinished sign-in) as macOS notifications,
 * when the window isn't in front: the banner shows them otherwise. Each at most once (NoticeAlerts, in Core). They
 * come from the live updates while unlocked, and from a check every few minutes while Cipherfilm is locked and keeps
 * running in the menu bar. The title says only that something happened ("New sign-in to Cipherfilm"); the body is
 * the banner's text (the device's own label and the time), which macOS hides when it hides previews (on the lock
 * screen by default). A click opens Settings › Security. Settings › Security turns them off. No push service: the app
 * itself asks its server.
 */
@MainActor enum NoticeNotifier {
  nonisolated static let category = "notice"
  private static let click = NoticeClick()

  static var enabled: Bool {
    get { UserDefaults.standard.object(forKey: "noticeNotifications") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "noticeNotifications") }
  }

  private static var seen: NoticeAlerts {
    get { UserDefaults.standard.data(forKey: "noticeAlerts").flatMap { try? JSONDecoder().decode(NoticeAlerts.self, from: $0) } ?? NoticeAlerts() }
    set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "noticeAlerts") }
  }

  /** Clicks on them; set at launch, so a click that launches the app is heard too. */
  static func setUp() {
    guard Bundle.main.bundleIdentifier != nil else { return }
    let c = UNUserNotificationCenter.current()
    c.setNotificationCategories([UNNotificationCategory(identifier: category, actions: [], intentIdentifiers: [],
      hiddenPreviewsBodyPlaceholder: "Open Cipherfilm to see it.", options: [.hiddenPreviewsShowTitle])])
    c.delegate = click
  }

  /** The window shows the banner: the app is in front with a window. */
  static var windowInFront: Bool { NSApp.isActive && NSApp.keyWindow?.isVisible == true }

  /** The notices just loaded: the new ones go out as notifications unless the window shows them (or this is off). */
  static func consider(_ list: [Notice], server: String, visible: Bool) {
    var s = seen
    // switched off: remembered as seen all the same, so turning it on later doesn't bring old ones
    let post = s.take(list, server: server, now: Date(), visible: visible || !enabled)
    seen = s
    guard !post.isEmpty, Bundle.main.bundleIdentifier != nil else { return }
    let items = post.map { n in
      (id: "notice-\(n.id)", title: NoticeAlerts.title(n), body: n.text(time: n.date.formatted(date: .abbreviated, time: .shortened)))
    }
    let c = UNUserNotificationCenter.current()
    c.requestAuthorization(options: [.alert, .sound]) { ok, _ in
      guard ok else { return }
      for i in items {
        let n = UNMutableNotificationContent()
        n.title = i.title
        n.body = i.body
        n.categoryIdentifier = category
        n.sound = .default
        c.add(UNNotificationRequest(identifier: i.id, content: n, trigger: nil))
      }
    }
  }

  /** Dismissed (here or on another device) or shown in the banner: its notification goes. */
  static func remove(_ ids: [Int64]) {
    guard !ids.isEmpty, Bundle.main.bundleIdentifier != nil else { return }
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids.map { "notice-\($0)" })
  }
}

/** A click on a notice's notification opens Settings › Security (the devices, two-step sign-in). */
private final class NoticeClick: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let notice = response.notification.request.content.categoryIdentifier == NoticeNotifier.category
    done()
    guard notice else { return }
    Task { @MainActor in AppModel.shared.agent.openSecurity() }
  }
}
