// macOS notifications when background work finishes (uploads, watched folders, the first full export or index).
// They say how many, never names or contents. Settings › General turns them off.
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
