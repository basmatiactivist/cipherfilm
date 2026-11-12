// Passkeys on the Mac through the browser (CipherfilmCore Passkeys): the server's /passkey page opens in a sign-in
// window (ASWebAuthenticationSession, the default browser), asks for the passkey on the server's own address, and hands
// the answer back to cipherfilm-mac://, which only this waiting window receives. A native passkey request would need
// the server's name in the app's Associated Domains, fixed when the app is built, so it can't work for any server.
import AppKit
import AuthenticationServices
import CipherfilmCore

@MainActor
final class PasskeyBrowser: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = PasskeyBrowser()
  private var session: ASWebAuthenticationSession?

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first ?? ASPresentationAnchor() }
  }

  /** Runs one passkey step ("get" a passkey's answer, or "create" a passkey) for the options; returns the answer JSON. */
  func run(server: URL, op: String, options: Data) async throws -> Data {
    let url = try Passkeys.handoffURL(server: server, op: op, options: options)
    session?.cancel()
    let back: URL = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
      let s = ASWebAuthenticationSession(url: url, callback: .customScheme(Passkeys.scheme)) { url, err in
        if let url { cont.resume(returning: url) } else { cont.resume(throwing: Self.friendly(err)) }
      }
      s.presentationContextProvider = self
      session = s
      if !s.start() { cont.resume(throwing: APIError(status: -1, message: "The browser window for the passkey didn't open.")) }
    }
    session = nil
    return try Passkeys.answer(from: back)
  }

  private nonisolated static func friendly(_ e: Error?) -> Error {
    if let e = e as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
      return APIError(status: -1, message: "No passkey was used. Try again, or use a code instead.")
    }
    return e ?? APIError(status: -1, message: "No passkey was used. Try again, or use a code instead.")
  }
}
