// "On this day" above Photos: one card per earlier year (CipherfilmCore/Memories.swift, the web and Android rules).
// A click opens that year's photos in the viewer. Settings › Memories turns the row off on this Mac.
import CipherfilmCore
import SwiftUI

struct MemoriesRow: View {
  @Environment(Navigator.self) private var nav
  let items: [Item]
  @AppStorage("memoriesOn") private var on = true
  @State private var memories: [Memory] = []

  /** worked out again when the library, the day or the setting changes; off the main thread for a big library */
  private var key: String {
    let day = Calendar.current.dateComponents([.year, .month, .day], from: Date())
    return "\(on)-\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)-\(items.count)-\(items.first?.id ?? "")-\(items.last?.id ?? "")"
  }

  var body: some View {
    // a stack, not a Group: with no memories it is still there to run the task
    VStack(alignment: .leading, spacing: 0) {
      if on && !memories.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("On this day").font(Typo.heading).foregroundStyle(Ink.ink)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
              ForEach(memories) { m in Card(memory: m) { nav.viewer = ViewerState(ids: m.items.map(\.id), index: 0) } }
            }
          }
        }
        .padding(.horizontal, 28).padding(.top, 6).padding(.bottom, 10)
      }
    }
    .task(id: key) {
      guard on else { memories = []; return }
      let list = items
      memories = await Task.detached(priority: .utility) { Memories.find(list) }.value
    }
  }

  private struct Card: View {
    let memory: Memory
    let open: () -> Void
    @State private var hover = false
    var body: some View {
      let date = memory.date.formatted(.dateTime.day().month(.abbreviated).year())
      Button(action: open) {
        VStack(alignment: .leading, spacing: 2) {
          Tile(item: memory.cover, selected: false)
            .frame(width: 120, height: 120)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(hover ? Ink.ruleStrong : Ink.rule, lineWidth: 2))
            .padding(.bottom, 4)
          Text(Memories.yearsAgo(memory.yearsAgo)).font(Typo.label).foregroundStyle(Ink.ink)
          Text(date).font(Typo.caption).foregroundStyle(Ink.muted)
        }
        .frame(width: 120, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .onHover { hover = $0 }
      .accessibilityLabel("\(Memories.yearsAgo(memory.yearsAgo)), \(date), \(memory.total) item\(memory.total == 1 ? "" : "s")")
    }
  }
}
