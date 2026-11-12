// "Report a Problem…" (Help menu and Settings): asks first, shows exactly what the link fills in, then opens the GitHub
// issue form in the browser. The app sends nothing itself; the link is built in CipherfilmCore (Report.swift).
import AppKit
import CipherfilmCore

enum ReportProblem {
  /** This Mac's details: the app version, the macOS version and the model identifier ("Mac16,7"), and the server's
   *  version (not its address). */
  @MainActor static func details(_ model: AppModel) -> Report.Details {
    Report.Details(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                   os: ProcessInfo.processInfo.operatingSystemVersion, model: hardwareModel(), serverVersion: model.me?.server_version)
  }

  static func hardwareModel() -> String? {
    var size = 0
    guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: size)
    guard sysctlbyname("hw.model", &buf, &size, nil, 0) == 0 else { return nil }
    return String(decoding: buf.prefix { $0 != 0 }, as: UTF8.self)
  }

  // An NSAlert rather than a sheet: the Help menu works with the window closed (the app keeps running in the menu bar)
  @MainActor static func ask(_ model: AppModel) {
    let d = details(model)
    let a = NSAlert()
    a.messageText = "Report a problem"
    a.informativeText = "You'll continue in the browser, on the project's issue tracker (posting needs a free account there). We'll fill in this Mac's details:\n\n\(d.summary)\n\nNothing else is sent: no server address, e-mail, photos or names."
    a.addButton(withTitle: "Include details")  // the default button (Return)
    a.addButton(withTitle: "Without details")
    a.addButton(withTitle: "Cancel")           // NSAlert gives a "Cancel" button Escape
    NSApp.activate()
    switch a.runModal() {
    case .alertFirstButtonReturn: NSWorkspace.shared.open(Report.url(d))
    case .alertSecondButtonReturn: NSWorkspace.shared.open(Report.url(nil))
    default: break
    }
  }
}
