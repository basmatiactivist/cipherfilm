// The year in review played as a story (the same pages and timing as the web and Android apps): over the whole window
// on black, a 9:16 column in the middle, one picture at a time with a bar of progress segments on top. The pages come
// from Recaps.slides (CipherfilmCore/Recap.swift). Click the right two thirds for the next page, the left third for the
// one before, hold to pause. Keys: ← → move, Space pauses or plays, Esc closes. With reduced motion or VoiceOver it
// starts paused (no slow zoom either) and shows Previous and Next. It pauses while the window isn't active or the
// viewer is open over it. Worked out on this Mac; nothing about the story goes to the server.
import AppKit
import CipherfilmCore
import SwiftUI

struct RecapStory: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.controlActiveState) private var windowState
  @Environment(\.scenePhase) private var phase
  let year: Int

  @State private var recap: Recap?
  @State private var done = false
  @State private var slides: [RecapSlide] = []
  @State private var trips: [String: Trip] = [:]
  @State private var people: [String: SearchEngine.Group] = [:]
  @State private var index = 0
  /** seconds into the current page */
  @State private var elapsed: Double = 0
  @State private var playing = true
  @State private var held = false
  @State private var pressAt: Date?
  @State private var voiceOver = NSWorkspace.shared.isVoiceOverEnabled
  @FocusState private var focused: Bool
  private let book = TripBook.shared

  static let slideSeconds = 5.0
  static let photoSeconds = 1.5

  /** no auto-advance and no zoom: the system asks for less motion, or a screen reader is on */
  private var manual: Bool { reduceMotion || voiceOver }
  private var current: RecapSlide? { slides.indices.contains(index) ? slides[index] : nil }
  private var running: Bool {
    playing && !held && windowState != .inactive && phase == .active && nav.viewer == nil && current != nil && current != .end
  }

  var body: some View {
    GeometryReader { g in
      let w = min(g.size.width, g.size.height * 9 / 16)
      ZStack {
        Ink.stage
        column(width: w).frame(width: w, height: g.size.height).clipped()
      }
      .frame(width: g.size.width, height: g.size.height)
    }
    .background(Ink.stage)
    .environment(\.colorScheme, .dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(String(year)) in review")
    .accessibilityAddTraits(.isModal)
    .focusable()
    .focusEffectDisabled()
    .focused($focused)
    .onAppear { focused = true; voiceOver = NSWorkspace.shared.isVoiceOverEnabled; playing = !manual }
    .onChange(of: nav.viewer) { if nav.viewer == nil { focused = true } }
    .onKeyPress(.leftArrow) { go(-1); return .handled }
    .onKeyPress(.rightArrow) { go(1); return .handled }
    .onKeyPress(.space) { playing.toggle(); return .handled }
    .onKeyPress(.escape) { close(); return .handled }
    .task(id: year) { await load() }
    .task(id: running) { await tick() }
    .task(id: index) { await preload() }
  }

  // ---- layout ----

  @ViewBuilder private func column(width: CGFloat) -> some View {
    ZStack {
      if let r = recap, let s = current {
        picture(s, r).id(index).transition(.opacity)
        shades
        // clicks and holds anywhere that isn't a button
        Color.clear.contentShape(Rectangle()).gesture(press(width: width)).accessibilityHidden(true)
        caption(s, r).id(index).transition(.opacity)
        VStack(spacing: 0) { top(r); Spacer(minLength: 0) }
        if manual {
          HStack {
            NavArrow(icon: "chevron.left", enabled: index > 0) { go(-1) }
            Spacer()
            NavArrow(icon: "chevron.right", enabled: index < slides.count - 1) { go(1) }
          }.padding(.horizontal, Space.s3)
        }
      } else if done {
        VStack(spacing: Space.s4) {
          Text("No photos from \(String(year))").font(Typo.dialog).foregroundStyle(Ink.onStage)
          Button("Close") { close() }.buttonStyle(StoryButton())
        }
      } else {
        Loading(label: "Looking back at \(String(year))…", stage: true)
      }
    }
  }

  /** Soft dark at the top and the bottom, so the white words read on any photo. */
  private var shades: some View {
    VStack(spacing: 0) {
      LinearGradient(colors: [Ink.stage.opacity(0.6), Ink.stage.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 140)
      Spacer(minLength: 0)
      LinearGradient(colors: [Ink.stage.opacity(0), Ink.stage.opacity(0.7)], startPoint: .top, endPoint: .bottom).frame(height: 260)
    }
    .allowsHitTesting(false).accessibilityHidden(true)
  }

  /** The progress segments, then the year, Pause or Play and Close. Clear of the window buttons. */
  private func top(_ r: Recap) -> some View {
    VStack(spacing: Space.s2) {
      HStack(spacing: Space.s1) {
        ForEach(slides.indices, id: \.self) { i in
          GeometryReader { g in
            ZStack(alignment: .leading) {
              Capsule().fill(Ink.onStage.opacity(0.35))
              Capsule().fill(Ink.onStage).frame(width: g.size.width * fill(i))
            }
          }.frame(height: 3)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Page \(index + 1) of \(slides.count)")
      HStack(spacing: Space.s1) {
        Text(String(r.year)).font(Typo.title).foregroundStyle(Ink.onStage).accessibilityHidden(true)
        Spacer()
        LightboxButton(icon: playing ? "pause.fill" : "play.fill", help: playing ? "Pause (Space)" : "Play (Space)") { playing.toggle() }
        LightboxButton(icon: "xmark", help: "Close (Esc)") { close() }
      }
    }
    .padding(.horizontal, Space.s3).padding(.top, 30)
  }

  private func fill(_ i: Int) -> CGFloat {
    if i < index { return 1 }
    if i > index { return 0 }
    guard let s = current, s != .end else { return 1 }
    return CGFloat(min(1, elapsed / duration(s)))
  }

  // ---- the pages ----

  /** The page's picture, edge to edge, slowly closer (not with reduced motion); dark for people and the end. */
  @ViewBuilder private func picture(_ s: RecapSlide, _ r: Recap) -> some View {
    let zoom = manual ? 1 : 1 + 0.06 * min(1, elapsed / duration(s))
    Group {
      switch s {
      case .cover: StoryPhoto(item: r.cover)
      case .month(let m):
        let photos = monthPhotos(m, r)
        if !photos.isEmpty {
          let it = photos[photoIndex(photos.count, s)]
          ZStack { StoryPhoto(item: it).id(it.id).transition(.opacity) }
            .animation(.easeInOut(duration: 0.6), value: it.id)
        }
      case .trip(let k): if let t = trips[k], let it = t.items.first { StoryPhoto(item: it) }
      case .places: if let p = r.places.first { StoryPhoto(item: p.cover) }
      case .people, .end: Ink.stage
      }
    }
    .scaleEffect(zoom)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label(s, r))
  }

  /** The words over the page, and its buttons. */
  @ViewBuilder private func caption(_ s: RecapSlide, _ r: Recap) -> some View {
    switch s {
    case .cover:
      bottom(open: r.cover) {
        Text(String(r.year)).font(Ink.serif(76)).foregroundStyle(Ink.onStage)
        Text(facts(r)).font(Typo.body).foregroundStyle(Ink.onStage)
      }
    case .month(let m):
      let photos = monthPhotos(m, r)
      bottom(open: photos.isEmpty ? nil : photos[photoIndex(photos.count, s)]) {
        Text(Calendar.current.standaloneMonthSymbols[m - 1]).font(Ink.serif(34)).foregroundStyle(Ink.onStage)
        Text(Self.items(r.months.first { $0.month == m }?.total ?? 0)).font(Typo.body).foregroundStyle(Ink.onStage)
      }
    case .trip(let k):
      if let t = trips[k] {
        bottom(open: t.items.first) {
          Text(Trips.title(t)).font(Ink.serif(28)).foregroundStyle(Ink.onStage).lineLimit(3)
          Text(Self.items(t.items.count)).font(Typo.body).foregroundStyle(Ink.onStage)
        }
      }
    case .places:
      if let p = r.places.first {
        bottom(open: p.cover) {
          Text("Where you were most").font(Typo.label).foregroundStyle(Ink.stageMuted)
          Text("\(p.name), \(p.country)").font(Ink.serif(28)).foregroundStyle(Ink.onStage).lineLimit(3)
          if r.places.count > 1 {
            Text(r.places.dropFirst().map(\.name).joined(separator: " · ")).font(Typo.body).foregroundStyle(Ink.stageMuted).lineLimit(2)
          }
        }
      }
    case .people:
      VStack(spacing: Space.s6) {
        Text("With you this year").font(Ink.serif(30)).foregroundStyle(Ink.onStage).multilineTextAlignment(.center)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: Space.s4)], spacing: Space.s5) {
          ForEach(r.people.filter { people[$0.key] != nil }) { p in
            let g = people[p.key]
            Button { close(); nav.go(.person(p.key)) } label: {
              VStack(spacing: 6) {
                FaceImage(cover: g?.cover, size: 88)
                Text(g?.name ?? "").font(Typo.name).foregroundStyle(Ink.onStage).lineLimit(1)
                Text("\(p.count) photo\(p.count == 1 ? "" : "s")").font(Typo.caption).foregroundStyle(Ink.stageMuted)
              }.frame(width: 104).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(g?.name ?? ""), \(p.count) photo\(p.count == 1 ? "" : "s")")
          }
        }
      }
      .padding(.horizontal, Space.s6)
    case .end:
      VStack(spacing: Space.s6) {
        Text("That was \(String(r.year))").font(Ink.serif(40)).foregroundStyle(Ink.onStage).multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        VStack(spacing: Space.s3) {
          Button("Watch again") { restart() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
          Button("All highlights") { close(); nav.go(.recap(year)) }.buttonStyle(StoryButton())
          Button("Close") { close() }.buttonStyle(StoryButton())
        }
      }
      .padding(.horizontal, Space.s6)
    }
  }

  /** Words at the bottom left; "Open" at the bottom right opens the photo in the viewer (the story pauses meanwhile). */
  private func bottom(open: Item?, @ViewBuilder _ words: () -> some View) -> some View {
    VStack {
      Spacer(minLength: 0)
      HStack(alignment: .bottom, spacing: Space.s3) {
        VStack(alignment: .leading, spacing: Space.s1) { words() }
          .allowsHitTesting(false).accessibilityHidden(true)
        Spacer(minLength: 0)
        if let open {
          Button("Open") { nav.viewer = ViewerState(ids: [open.id], index: 0) }.buttonStyle(StoryButton())
        }
      }
      .padding(.horizontal, Space.s5).padding(.bottom, Space.s6)
    }
  }

  private func monthPhotos(_ m: Int, _ r: Recap) -> [Item] {
    r.months.first { $0.month == m }.map(Recaps.storyPhotos) ?? []
  }

  /** Which of a month's photos shows now: each for an equal share of the page. */
  private func photoIndex(_ n: Int, _ s: RecapSlide) -> Int {
    guard n > 1 else { return 0 }
    return min(n - 1, max(0, Int(elapsed / (duration(s) / Double(n)))))
  }

  private func duration(_ s: RecapSlide) -> Double {
    if case .month(let m) = s, let r = recap { return max(Self.slideSeconds, Double(monthPhotos(m, r).count) * Self.photoSeconds) }
    return Self.slideSeconds
  }

  static func items(_ n: Int) -> String { "\(n) item\(n == 1 ? "" : "s")" }

  private func facts(_ r: Recap) -> String {
    let n = { (k: Int, one: String, many: String) in "\(k) \(k == 1 ? one : many)" }
    return [n(r.photos, "photo", "photos"), r.videos > 0 ? n(r.videos, "video", "videos") : "", n(r.days, "day with photos", "days with photos"),
            r.countries > 1 ? n(r.countries, "country", "countries") : ""]
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }

  /** What VoiceOver says for a page. */
  private func label(_ s: RecapSlide, _ r: Recap) -> String {
    switch s {
    case .cover: return "\(String(r.year)) in review, \(facts(r))"
    case .month(let m):
      let photos = monthPhotos(m, r)
      let total = r.months.first { $0.month == m }?.total ?? 0
      return "\(Calendar.current.standaloneMonthSymbols[m - 1]) \(String(r.year)), \(Self.items(total))"
        + (photos.count > 1 ? ", photo \(photoIndex(photos.count, s) + 1) of \(photos.count)" : "")
    case .trip(let k): return trips[k].map { "\(Trips.title($0)), \(Self.items($0.items.count))" } ?? ""
    case .places:
      guard let p = r.places.first else { return "" }
      let others = r.places.dropFirst().map(\.name)
      return "Where you were most: \(p.name), \(p.country)" + (others.isEmpty ? "" : ". Also \(others.joined(separator: ", "))")
    case .people: return "With you this year: " + r.people.compactMap { people[$0.key]?.name }.joined(separator: ", ")
    case .end: return "That was \(String(r.year))"
    }
  }

  // ---- moving on ----

  /** A click: the left third goes back, the rest on. A hold pauses while it lasts. */
  private func press(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { _ in if pressAt == nil { pressAt = Date() }; held = true }
      .onEnded { v in
        let short = Date().timeIntervalSince(pressAt ?? Date()) < 0.3
        let still = abs(v.translation.width) < 10 && abs(v.translation.height) < 10
        pressAt = nil; held = false
        if short && still { go(v.location.x < width / 3 ? -1 : 1) }
      }
  }

  private func go(_ d: Int) {
    let i = index + d
    guard slides.indices.contains(i) else { return }
    withAnimation(.easeInOut(duration: Motion.medium)) { index = i; elapsed = 0 }
  }

  private func restart() {
    withAnimation(.easeInOut(duration: Motion.medium)) { index = 0; elapsed = 0 }
    playing = !manual
  }

  private func close() { nav.story = nil }

  /** Moves the progress on while the story plays; on to the next page when this one is over. */
  private func tick() async {
    guard running else { return }
    let clock = ContinuousClock()
    var last = clock.now
    while !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(16))
      if Task.isCancelled { return }
      let now = clock.now
      elapsed += (now - last) / .seconds(1)
      last = now
      if let s = current, elapsed >= duration(s) {
        if index < slides.count - 1 { go(1) } else { elapsed = duration(s) }
      }
    }
  }

  /** The sharp pictures of this page and the next, loaded ahead. */
  private func preload() async {
    guard let r = recap, let v = model.vault else { return }
    for i in [index, index + 1] where slides.indices.contains(i) {
      for it in items(slides[i], r) where !Task.isCancelled { _ = await model.images.preview(it, v) }
    }
  }

  private func items(_ s: RecapSlide, _ r: Recap) -> [Item] {
    switch s {
    case .cover: return [r.cover]
    case .month(let m): return monthPhotos(m, r)
    case .trip(let k): return trips[k]?.items.first.map { [$0] } ?? []
    case .places: return r.places.first.map { [$0.cover] } ?? []
    case .people, .end: return []
    }
  }

  /** The recap as the overview page works it out (named, not hidden people), the year's trips, and the pages. */
  private func load() async {
    let groups = await model.search.peopleGroups().filter { !$0.name.isEmpty && $0.person?.hidden != true }
    let list = model.items, y = year, keyed = groups.map { (key: $0.key, items: $0.items) }
    let r = await Task.detached(priority: .userInitiated) {
      Recaps.recap(list, year: y, lookup: placeLookup, people: keyed)
    }.value
    await book.update(model.items)
    let cal = Calendar.current
    let ofYear = (book.trips ?? []).filter {
      cal.component(.year, from: Date(timeIntervalSince1970: $0.start / 1000)) == y || cal.component(.year, from: Date(timeIntervalSince1970: $0.end / 1000)) == y
    }
    people = Dictionary(groups.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    trips = Dictionary(ofYear.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    if let r {
      slides = Recaps.slides(r, trips: ofYear, people: r.people.contains { people[$0.key] != nil })
      index = 0; elapsed = 0
    }
    recap = r
    done = true
  }
}

/** A picture filling its page: the thumbnail at once, the sharp preview when it has loaded. */
private struct StoryPhoto: View {
  @Environment(AppModel.self) private var model
  let item: Item
  @State private var image: NSImage?

  var body: some View {
    GeometryReader { g in
      ZStack {
        Ink.stage
        if let image {
          Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
            .frame(width: g.size.width, height: g.size.height).clipped()
        }
      }
    }
    .task(id: item.pictureKey) {
      guard !item.broken, !item.isLocked, let v = model.vault else { return }
      if let t = model.images.cachedThumb(item) { image = t } else if let t = await model.images.thumb(item, v) { image = t }
      if let p = await model.images.preview(item, v) { image = p }
    }
  }
}

/** A quiet button on the black story: white words on a translucent ground, lighter under the pointer. */
private struct StoryButton: ButtonStyle {
  @State private var hover = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Typo.label)
      .padding(.horizontal, Space.s4).frame(minHeight: Metric.control)
      .foregroundStyle(Ink.onStage)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(configuration.isPressed ? Ink.stageNavHover : hover ? Ink.stageHover : Ink.stageNav))
      .contentShape(Rectangle())
      .onHover { hover = $0 }
  }
}
