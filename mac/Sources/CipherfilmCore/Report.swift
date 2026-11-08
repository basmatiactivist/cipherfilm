// "Report a problem": a link to the GitHub issue form (.github/ISSUE_TEMPLATE/bug_report.yml), prefilled with this
// Mac's details only when the person agrees to it in the dialog. The app sends nothing itself: the browser opens the
// link, and the person sees and can change every field on github.com before posting. Android and the web app build the
// same link, byte for byte (mobile/src/report.ts, web/src/report.ts); the field ids are the form's.
import Foundation

public enum Report {
  public static let issueForm = "https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml"

  /** What goes into the form: exactly these fields, and exactly what the dialog shows (summary). No server address,
   *  e-mail, names or anything about the library: the form is public. */
  public struct Details: Equatable, Sendable {
    /** One of the form's "Which app?" options, word for word. */
    public let app = "Mac"
    /** "2.3.0 (Mac)" */
    public let appVersion: String
    /** "macOS 26.1 · Mac16,7" */
    public let device: String
    /** The server's version, when known; not its address. */
    public let serverVersion: String?

    public init(version: String?, os: OperatingSystemVersion, model: String?, serverVersion: String?) {
      appVersion = "\(version?.isEmpty == false ? version! : "unknown") (Mac)"
      let v = os.patchVersion > 0 ? "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)" : "\(os.majorVersion).\(os.minorVersion)"
      device = model.map { $0.isEmpty ? "macOS \(v)" : "macOS \(v) · \($0)" } ?? "macOS \(v)"
      self.serverVersion = serverVersion?.isEmpty == false ? serverVersion : nil
    }

    /** The line the dialog shows, built from the same fields the link carries. */
    public var summary: String {
      ["Cipherfilm \(clean(appVersion))", clean(device), serverVersion.map { "Server \(clean($0))" }].compactMap { $0 }.joined(separator: " · ")
    }
  }

  /** The link; without details it is only the empty form. */
  public static func url(_ d: Details?) -> URL {
    guard let d else { return URL(string: issueForm)! }
    let fields: [(String, String?)] = [("app", d.app), ("app_version", d.appVersion), ("device", d.device), ("server_version", d.serverVersion)]
    let q = fields.compactMap { k, v in v.map(clean).flatMap { $0.isEmpty ? nil : "&\(k)=\(encode($0))" } }.joined()
    return URL(string: issueForm + q)!
  }

  // Control characters go, and a length cap keeps an odd value from making the link too long for GitHub (414); the
  // same as the other apps, so a report reads the same from each.
  static func clean(_ s: String) -> String {
    String(String(String.UnicodeScalarView(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }))
      .trimmingCharacters(in: .whitespaces).prefix(120))
  }

  // RFC 3986 unreserved characters only (what the other apps' strict encodeURIComponent leaves): UTF-8 percent-escaped
  private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  static func encode(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved)! }
}
