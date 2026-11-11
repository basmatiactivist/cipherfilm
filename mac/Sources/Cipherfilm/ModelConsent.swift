// The question before the search models are downloaded from Hugging Face (ModelStore in CipherfilmCore,
// docs/MODELS.md), in the look and words of the map's (MapPage.swift MapConsent): what, how big, from whom, what they
// learn, and the two buttons.
import AppKit
import SwiftUI

struct ModelConsentSheet: View {
  let ask: ModelConsentAsk
  let yes: () -> Void
  let later: () -> Void
  static let privacy = URL(string: "https://cipherfilm.app/privacy#models")!

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Image(systemName: "arrow.down.circle").font(.system(size: 30)).foregroundStyle(Ink.teal)
      Text("Download the search models?").font(Typo.dialog).foregroundStyle(Ink.ink)
      Text("Search runs on this Mac with open models. Cipherfilm downloads them once for this Mac: \(ask.what), \(Self.mb(ask.bytes)) in all.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      Text("They come from Hugging Face (huggingface.co and its CDN, *.hf.co), where these models are published. Hugging Face sees this Mac's IP address and that it downloaded these public files. It gets no photos, faces, search words or account data.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      Text("Each file is checked (SHA-256) before it is used. Turning search off in Settings › Search & People deletes the models again.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 16) {
        Button("Download and turn on", action: yes).buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
        Button("Not now", action: later).buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction)
        Button("Privacy policy") { NSWorkspace.shared.open(Self.privacy) }.buttonStyle(TextLink())
      }
      .padding(.top, 4)
    }
    .padding(28)
    .frame(width: 480, alignment: .leading)
    .background(Ink.card)
  }

  static func mb(_ n: Int64) -> String { "\(max(1, Int((Double(n) / 1e6).rounded()))) MB" }
}
