// "Stay unlocked while an import or export runs" (Settings › General, off by default): a long WebDAV import or export
// would otherwise stop when the screen turns off or locks, since both lock the library and the work needs its key.
// With the option on, those locks wait until the work is done (or the person unlocks the screen again), and the Mac
// doesn't fall asleep on its own meanwhile. Real sleep (the lid, the Apple menu) still locks at once: the network is
// gone then anyway.
import Foundation

enum StayUnlocked {
  static var on: Bool {
    get { UserDefaults.standard.bool(forKey: "stayUnlockedWhileWorking") }
    set { UserDefaults.standard.set(newValue, forKey: "stayUnlockedWhileWorking") }
  }

  /** What the screen turning off or locking does. */
  enum Action: Equatable { case lock, later, nothing }
  static func onScreenLock(lockOnSleep: Bool, stay: Bool, working: Bool) -> Action {
    guard lockOnSleep else { return .nothing }
    return stay && working ? .later : .lock
  }
}

/** Keeps the Mac from idle sleep while the work runs (the screen may still turn off). */
@MainActor final class KeepAwake {
  private var activity: NSObjectProtocol?
  var active: Bool { activity != nil }

  func set(_ on: Bool) {
    if on, activity == nil {
      activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated],
                                                       reason: "Importing or exporting photos")
    } else if !on, let a = activity {
      ProcessInfo.processInfo.endActivity(a)
      activity = nil
    }
  }
}
