// Cipherfilm for macOS: the library window, Settings, and the menu-bar item that keeps working with the window closed.
import AppKit
import CipherfilmCore
import SwiftUI

@main
struct CipherfilmApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel.shared

  var body: some Scene {
    Window("Cipherfilm", id: "main") {
      RootView()
        .environment(model)
        .frame(minWidth: 760, minHeight: 520)
    }
    .defaultSize(width: 1240, height: 820)
    .defaultLaunchBehavior(Agent.launchedAtLogin ? .suppressed : .presented)
    .commands { Commands(model: model) }

    Settings {
      SettingsView().environment(model)
    }

    MenuBarExtra {
      MenuBarView().environment(model)
    } label: {
      MenuBarLabel(busy: model.busy)
    }
    .menuBarExtraStyle(.window)
  }
}

struct Commands: SwiftUI.Commands {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some SwiftUI.Commands {
    CommandGroup(replacing: .newItem) {
      Button("Upload Photos and Videos…") { UploadPicker.pick(model) }
        .keyboardShortcut("u", modifiers: [.command])
        .disabled(model.phase != .unlocked)
    }
    CommandGroup(after: .appSettings) {
      Button("Lock Cipherfilm") { model.lock() }
        .keyboardShortcut("l", modifiers: [.command, .control])
        .disabled(model.phase != .unlocked)
    }
    // the quick actions, on the photo in the viewer or on the selection
    CommandMenu("Photo") {
      let ids = model.targets
      let one = ids.count == 1 ? model.item(ids[0]) : nil
      let fav = !ids.isEmpty && ids.allSatisfy { model.item($0)?.favorite == true }
      Button(fav ? "Remove from Favorites" : "Add to Favorites") { model.setFavorite(ids, !fav) }
        .keyboardShortcut("f", modifiers: [.command, .shift]).disabled(ids.isEmpty)
      Button("Add to Album…") { model.nav?.albumPickFor = ids }
        .keyboardShortcut("a", modifiers: [.command, .control]).disabled(ids.isEmpty)
      Button("New Album with Selection…") { model.nav?.newAlbumFor = ids }
        .keyboardShortcut("n", modifiers: [.command, .shift]).disabled(ids.isEmpty)
      Divider()
      Button("Share…") { Outbox.share(ids.compactMap { model.item($0) }, model) }
        .keyboardShortcut("s", modifiers: [.command, .shift]).disabled(ids.isEmpty)
      Button(ids.count > 1 ? "Save Originals…" : "Save Original…") { Saver.save(ids.compactMap { model.item($0) }, model) }
        .keyboardShortcut("e", modifiers: [.command, .shift]).disabled(ids.isEmpty)
      Button("Photos Like This One") { if let one { model.nav?.showSimilar(one.id) } }
        .keyboardShortcut("k", modifiers: .command).disabled(one == nil || !model.search.ready)
      Divider()
      Button("Go to Date…") { model.nav?.jumpPicker = true }
        .keyboardShortcut("j", modifiers: .command)
      Divider()
      Button("Move to Trash") { model.moveToTrash(ids); model.selection?.clear(); if model.nav?.viewer != nil { model.nav?.viewer = nil } }
        .keyboardShortcut(.delete, modifiers: .command).disabled(ids.isEmpty)
    }
    CommandGroup(replacing: .windowList) {
      Button("Cipherfilm") { model.agent.showWindow(openWindow) }.keyboardShortcut("0", modifiers: [.command])
    }
  }
}

/** The menu-bar icon, which is there from launch on: it hands the window opener to the Agent, so a second launch of the
 *  app can bring this one's window back. */
struct MenuBarLabel: View {
  let busy: Bool
  @Environment(\.openWindow) private var openWindow
  var body: some View {
    Image(nsImage: MenuBarIcon.image(busy: busy))
      .onAppear { AppModel.shared.agent.opener = openWindow }
  }
}

enum UploadPicker {
  @MainActor static func pick(_ model: AppModel) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = true
    p.canChooseDirectories = true
    p.canChooseFiles = true
    p.allowedContentTypes = [.image, .movie, .audiovisualContent, .folder]
    p.message = "Choose photos, videos or folders to upload."
    p.prompt = "Upload"
    if p.runModal() == .OK { model.upload(p.urls) }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      switch model.phase {
      case .starting: Loading(label: "Opening Cipherfilm…")
      case .noServer: ServerView()
      case .signedOut: SignInView()
      case .locked: UnlockView()
      case .unlocked: MainView()
      }
    }
    .background(Ink.paper)
    .foregroundStyle(Ink.ink)
    .tint(Ink.teal)
    .sheet(isPresented: Binding(get: { model.agent.askNow }, set: { if !$0 { model.agent.askNow = false } })) { AgentQuestion() }
    .alert("That didn't work", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
      Button("OK", role: .cancel) {}
    } message: { Text(model.alert ?? "") }
    .overlay(alignment: .bottom) {
      if let w = model.working {
        HStack(spacing: 10) { Loader(); Text(w).font(Typo.label) }
          .padding(.horizontal, 16).padding(.vertical, 10)
          .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card).shadow(color: Ink.shade, radius: Metric.menuShadowRadius, y: Metric.menuShadowY))
          .padding(.bottom, 90)
      }
    }
  }
}

extension AppDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      Task {
        await AppModel.shared.start()
        #if DEBUG
        await DebugDriver.run()
        #endif
      }
    }
  }
}
