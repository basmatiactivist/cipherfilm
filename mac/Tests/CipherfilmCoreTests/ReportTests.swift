// "Report a problem": the link the Mac opens matches the form's fields and the other apps' escaping, and carries
// nothing without the person's yes.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct ReportTests {
  private let os = OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 0)

  @Test func fillsInTheFormsFields() {
    let d = Report.Details(version: "2.3.0", os: os, model: "Mac16,7", serverVersion: "2.3.0")
    #expect(d.summary == "Cipherfilm 2.3.0 (Mac) · macOS 26.1 · Mac16,7 · Server 2.3.0")
    #expect(Report.url(d).absoluteString == Report.issueForm + "&app=Mac&app_version=2.3.0%20%28Mac%29&device=macOS%2026.1%20%C2%B7%20Mac16%2C7&server_version=2.3.0")
    let items = URLComponents(url: Report.url(d), resolvingAgainstBaseURL: false)!.queryItems!
    #expect(items.map(\.name) == ["template", "app", "app_version", "device", "server_version"])
    #expect(items.first { $0.name == "device" }?.value == "macOS 26.1 · Mac16,7")
  }

  @Test func leavesOutWhatItDoesntKnow() {
    let d = Report.Details(version: nil, os: OperatingSystemVersion(majorVersion: 15, minorVersion: 7, patchVersion: 2), model: nil, serverVersion: "")
    #expect(d.summary == "Cipherfilm unknown (Mac) · macOS 15.7.2")
    #expect(!Report.url(d).absoluteString.contains("server_version"))
  }

  @Test func escapesWhatWouldBreakTheQuery() {
    let d = Report.Details(version: "2.3.0", os: os, model: "a&server_version=1#b+c\n", serverVersion: nil)
    let items = URLComponents(url: Report.url(d), resolvingAgainstBaseURL: false)!.queryItems!
    #expect(items.first { $0.name == "device" }?.value == "macOS 26.1 · a&server_version=1#b+c")
    #expect(items.filter { $0.name == "server_version" }.isEmpty)
  }

  @Test func withoutDetailsOnlyTheForm() {
    #expect(Report.url(nil).absoluteString == "https://github.com/basmatiactivist/cipherfilm/issues/new?template=bug_report.yml")
  }
}
