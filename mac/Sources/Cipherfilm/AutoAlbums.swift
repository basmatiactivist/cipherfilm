// Trips and year recaps (CipherfilmCore/Trips.swift and Recap.swift, the web and Android rules): worked out on this
// Mac from the decrypted dates and places, kept in memory only. Trips are suggested albums under Albums; one reaches
// the server only when it is saved as an album (then it is an ordinary encrypted album). Year recaps are a row of
// cards under "On this day" that play the year as a story (RecapStory.swift); its overview page is reached from the
// story's end. Both follow Settings › Memories, like "On this day".
import CipherfilmCore
import SwiftUI

/** Place names for trips and recaps: the bundled file's lookup, nil without the file. */
let placeLookup: Trips.Lookup? = {
  guard let p = PlaceBook.places else { return nil }
  return { (la: Double, lo: Double) -> PlaceHit? in p.nearest(la, lo) }
}()

/** The trips of the library, worked out off the main thread once per library change and kept until the next one. */
@MainActor @Observable
final class TripBook {
  static let shared = TripBook()
  private(set) var trips: [Trip]?
  private var key = ""
  /** bumped by each update and by forget(): a result worked out for an older list, or before a lock, is dropped */
  private(set) var generation = 0

  /** The library's trips, worked out again when it changed. */
  func update(_ items: [Item]) async {
    let k = "\(items.count)-\(items.first?.id ?? "")-\(items.last?.id ?? "")-\(items.reduce(0) { $0 &+ $1.id.hashValue &+ $1.when.hashValue })"
    guard k != key else { return }
    key = k
    generation += 1
    let gen = generation
    let list = items
    let found = await Task.detached(priority: .utility) {
      Trips.find(list, lookup: placeLookup)
    }.value
    guard gen == generation else { return }
    trips = found
  }

  func trip(_ key: String) -> Trip? { trips?.first { $0.key == key } }
  func forget() { trips = nil; key = ""; generation += 1 }
}

/** A square photo with a title and a line under it, for the rows and grids here. */
private struct Card: View {
  let cover: Item?
  let title: String
  let sub: String
  var size: CGFloat = 120
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ZStack {
        Rectangle().fill(Ink.paperDeep)
        if let cover { Tile(item: cover, selected: false) } else { Image(systemName: "photo").foregroundStyle(Ink.faint) }
      }
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: Radius.card))
      .padding(.bottom, 4)
      Text(title).font(Typo.label).foregroundStyle(Ink.ink).lineLimit(2)
      Text(sub).font(Typo.caption).foregroundStyle(Ink.muted).lineLimit(1)
    }
    .frame(width: size, alignment: .leading)
  }
}

/** "Your years" under "On this day": a card for every earlier year, and this one from December. */
struct YearsRow: View {
  @Environment(Navigator.self) private var nav
  let items: [Item]
  @AppStorage("memoriesOn") private var on = true
  @State private var cards: [(year: Int, cover: Item?, count: Int)] = []

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if on && !cards.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("Your years").font(Typo.heading).foregroundStyle(Ink.ink)
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
              ForEach(cards, id: \.year) { c in
                Button { withAnimation(.easeOut(duration: Motion.medium)) { nav.story = c.year } } label: { Card(cover: c.cover, title: String(c.year), sub: "In review") }
                  .buttonStyle(.plain)
                  .accessibilityLabel("\(c.year) in review, \(c.count) item\(c.count == 1 ? "" : "s")")
              }
            }
          }
        }
        .padding(.horizontal, 28).padding(.top, 6).padding(.bottom, 10)
      }
    }
    .task(id: "\(on)-\(items.count)-\(items.first?.id ?? "")") {
      guard on else { cards = []; return }
      let list = items
      cards = await Task.detached(priority: .utility) {
        let cal = Calendar.current
        return Recaps.years(list).map { y in
          let mine = list.filter { !$0.broken && $0.trashedAt == nil && cal.component(.year, from: $0.date) == y }
          let favs = mine.filter(\.favorite)
          return (year: y, cover: Recaps.highlights(favs.isEmpty ? mine : favs, 1).first ?? mine.first, count: mine.count)
        }
      }.value
    }
  }
}

/** Suggested albums under Albums: the trips. */
struct TripsSection: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @AppStorage("memoriesOn") private var on = true
  private let book = TripBook.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if on, let trips = book.trips, !trips.isEmpty {
        Text("Trips").font(Typo.heading).foregroundStyle(Ink.ink)
        Text("Suggested from when and where your photos were taken, worked out on this Mac. Save one to keep it as an album.")
          .font(Typo.caption).foregroundStyle(Ink.muted)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 20)], alignment: .leading, spacing: 22) {
          ForEach(trips) { t in
            let saved = Trips.savedAs(t, in: model.albums) != nil
            Button { nav.go(.trip(t.key)) } label: {
              TripCover(trip: t, sub: "\(t.items.count) item\(t.items.count == 1 ? "" : "s")" + (saved ? " · Saved" : ""))
            }.buttonStyle(TileButton())
          }
        }
      }
    }
    .padding(.horizontal, 28).padding(.vertical, 12)
    .task(id: on ? model.itemsVersion : -1) { if on { await book.update(model.items) } }
  }
}

private struct TripCover: View {
  let trip: Trip
  let sub: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack {
        Rectangle().fill(Ink.paperDeep)
        if let c = Recaps.highlights(trip.items, 1).first ?? trip.items.first { Tile(item: c, selected: false) }
      }
      .aspectRatio(1, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: Radius.card))
      Text(Trips.title(trip)).font(Typo.name).foregroundStyle(Ink.ink).lineLimit(2)
      Text(sub).font(Typo.caption).foregroundStyle(Ink.muted)
    }
  }
}

/** A suggested trip: its photos, and saving it as an album (or opening the album it was saved as). */
struct TripView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let key: String
  @Bindable var selection: Selection
  private let book = TripBook.shared

  var body: some View {
    let trip = book.trip(key)
    VStack(spacing: 0) {
      if let trip {
        let saved = Trips.savedAs(trip, in: model.albums)
        let days = "\(trip.start.day) – \(trip.end.day) · \(trip.items.count) item\(trip.items.count == 1 ? "" : "s")"
        HStack(alignment: .bottom) {
          PageTitle(title: Trips.title(trip), subtitle: days)
          if let saved {
            Button("Open the Album") { nav.go(.album(saved.id)) }.buttonStyle(SecondaryButton()).padding(.trailing, 28)
          } else if model.me?.isDemo != true {
            Button("Save as Album") {
              let ids = trip.items.map(\.id), name = Trips.title(trip)
              model.perform { v in let a = try await v.createAlbum(name); try await v.addToAlbum(a.id, ids) }
            }.buttonStyle(PrimaryButton()).fixedSize().padding(.trailing, 28)
          }
        }
        if saved == nil {
          Text("Only this Mac knows about this trip until you save it. An album is encrypted like the rest.")
            .font(Typo.caption).foregroundStyle(Ink.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 28).padding(.bottom, 6)
        }
        PhotoGrid(items: trip.items.sorted { $0.when > $1.when }, selection: selection) { it, list in nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0) }
      } else if book.trips == nil {
        Loading(label: "Looking for trips…")
      } else {
        PageTitle(title: "Trip")
        Spacer(); EmptyState(icon: "map", title: "This trip isn't in your library anymore", text: "Its photos may have been moved to the trash or changed on another device."); Spacer()
      }
    }
    .task(id: model.itemsVersion) { await book.update(model.items) }
  }
}

private extension Double {
  /** a capture time in ms as "12 May 2026" */
  var day: String { Date(timeIntervalSince1970: self / 1000).formatted(.dateTime.day().month(.abbreviated).year()) }
}

/** A year in review: the numbers, places and people seen most, its trips, and a few photos of each month. */
struct RecapView: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let year: Int
  @State private var recap: Recap?
  @State private var done = false
  @State private var names: [String: String] = [:]
  private let book = TripBook.shared

  var body: some View {
    VStack(spacing: 0) {
      PageTitle(title: "\(String(year)) in review", subtitle: recap.map(facts))
      if let r = recap {
        ScrollView {
          VStack(alignment: .leading, spacing: 18) {
            if !r.places.isEmpty {
              section("Places") {
                ScrollView(.horizontal, showsIndicators: false) {
                  HStack(alignment: .top, spacing: 12) {
                    ForEach(r.places) { p in Card(cover: p.cover, title: p.name, sub: "\(p.country) · \(p.count)") }
                  }
                }
              }
            }
            if !r.people.isEmpty {
              section("People") {
                HStack(spacing: 8) {
                  ForEach(r.people) { p in
                    Button("\(names[p.key] ?? "") · \(p.count)") { nav.go(.person(p.key)) }.buttonStyle(SecondaryButton())
                  }
                }
              }
            }
            let trips = (book.trips ?? []).filter { Calendar.current.component(.year, from: Date(timeIntervalSince1970: $0.start / 1000)) == year || Calendar.current.component(.year, from: Date(timeIntervalSince1970: $0.end / 1000)) == year }
            if !trips.isEmpty {
              section("Trips") {
                HStack(spacing: 8) { ForEach(trips) { t in Button(Trips.title(t)) { nav.go(.trip(t.key)) }.buttonStyle(SecondaryButton()) } }
              }
            }
            ForEach(r.months) { m in
              section("\(Calendar.current.monthSymbols[m.month - 1]) · \(m.total)") {
                HStack(spacing: 8) {
                  ForEach(Array(m.highlights.enumerated()), id: \.element.id) { i, it in
                    Button { nav.viewer = ViewerState(ids: m.highlights.map(\.id), index: i) } label: {
                      Tile(item: it, selected: false).frame(width: 150, height: 150).clipShape(RoundedRectangle(cornerRadius: Radius.tile))
                    }.buttonStyle(.plain).accessibilityLabel("Open \(it.name)")
                  }
                }
              }
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 28).padding(.vertical, 12)
        }
      } else if done {
        Spacer(); EmptyState(icon: "photo.on.rectangle", title: "No photos from \(String(year))", text: "Photos and videos taken in \(String(year)) show up here."); Spacer()
      } else {
        Loading(label: "Looking back at \(String(year))…")
      }
    }
    .task(id: "\(year)-\(model.items.count)-\(model.search.version)") {
      let groups = await model.search.peopleGroups().filter { !$0.name.isEmpty && $0.person?.hidden != true }
      names = Dictionary(groups.map { ($0.key, $0.name) }, uniquingKeysWith: { a, _ in a })
      let list = model.items, y = year, people = groups.map { (key: $0.key, items: $0.items) }
      recap = await Task.detached(priority: .userInitiated) {
        Recaps.recap(list, year: y, lookup: placeLookup, people: people)
      }.value
      done = true
      await book.update(model.items)
    }
  }

  private func facts(_ r: Recap) -> String {
    let n = { (k: Int, one: String, many: String) in "\(k) \(k == 1 ? one : many)" }
    return [n(r.photos, "photo", "photos"), r.videos > 0 ? n(r.videos, "video", "videos") : "", n(r.days, "day", "days"), r.countries > 1 ? n(r.countries, "country", "countries") : ""]
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }

  @ViewBuilder private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(Typo.heading).foregroundStyle(Ink.ink)
      content()
    }
  }
}
