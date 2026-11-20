// Custom reviews: searches the person saved, played as a story like the year in review once a day, week or month, with
// different photos each time (the rules: CipherfilmCore/CustomReview.swift, the same as the web and Android apps).
// The document lives on the server as the encrypted "reviews" document, shared by all the person's devices; the
// server never learns what a review searches for, what it's called or what it showed. Each device runs the search on
// its own library view (SearchEngine, with this Mac's explicit filter). Settings › General › Memories › Custom
// reviews lists them; the home row (AutoAlbums.swift) plays the due ones (RecapStory.swift). No notifications on the
// Mac: the server must not schedule anything.
import CipherfilmCore
import SwiftUI

@MainActor @Observable
final class ReviewStore {
  static let oldServer = "Your server needs an update for custom reviews."

  private(set) var doc = ReviewDoc()
  /** the document was read for the open library */
  private(set) var loaded = false
  private(set) var problem: String?
  /** bumped whenever the document changed (here or elsewhere) */
  private(set) var revision = 0
  @ObservationIgnored private var version = 0
  /** the vault the document was opened with: another one (locked and unlocked, another account) starts afresh */
  @ObservationIgnored private weak var owner: Vault?
  @ObservationIgnored private var loading: Task<Void, Error>?

  private var vault: Vault? { AppModel.shared.vault }

  /** What a review plays now: the photos picked (or picked before in this period), out of how many matches. */
  struct Played {
    let review: Review
    let period: Int
    let picked: [Item]
    let total: Int
    let slides: [ReviewSlide]
  }

  /** At a lock or sign-out: nothing of the document stays in memory. */
  func forget() {
    loading?.cancel(); loading = nil
    doc = ReviewDoc(); version = 0; loaded = false; owner = nil; problem = nil; revision += 1
  }

  /** Another device changed the document (live updates). */
  func changedElsewhere() {
    guard loaded else { return }
    Task { try? await load() }
  }

  /** Loads the document the first time it's needed for this vault. */
  func ensure() async {
    if loaded && owner === vault && vault != nil { return }
    try? await load()
  }

  /** Reads the document (again). A server without it (404): no reviews yet, or a server from before them. */
  func load() async throws {
    if let loading { return try await loading.value }
    let t = Task { try await fetch() }
    loading = t
    defer { loading = nil }
    do { try await t.value } catch { if !(error is CancellationError) { problem = error.localizedDescription }; throw error }
  }

  private func fetch() async throws {
    guard let v = vault else { throw APIError(status: -1, message: "Unlock your library first.") }
    struct R: Decodable { let data_enc: String; let version: Int }
    var next = ReviewDoc(), ver = 0
    do {
      let r = try await v.api.get(R.self, "/api/me/blobs/reviews")
      next = CustomReviews.readDoc(try Crypto.decryptReviews(B64.decode(r.data_enc), master: v.masterKey(), userId: v.userId))
      ver = r.version
    } catch let e as APIError where e.status == 404 {}
    guard vault === v, !Task.isCancelled else { return } // locked meanwhile
    doc = next; version = ver; owner = v; loaded = true; problem = nil; revision += 1
  }

  /** Applies a change and saves it; when another device saved in between, the change is applied to theirs. */
  @discardableResult
  private func change(_ f: (ReviewDoc) throws -> ReviewDoc) async throws -> ReviewDoc {
    guard let v = vault else { throw APIError(status: -1, message: "Unlock your library first.") }
    for i in 0..<4 {
      if !loaded || owner !== v || i > 0 { try await load() }
      let next = CustomReviews.tidy(try f(doc), now: Date().timeIntervalSince1970 * 1000)
      do {
        let blob = Crypto.encryptReviews(try CustomReviews.encode(next), master: try v.masterKey(), userId: v.userId)
        struct R: Decodable { let version: Int }
        let d = try await v.api.json("PUT", "/api/me/blobs/reviews", body: ["data_enc": B64.encode(blob), "version": version] as [String: Any])
        guard vault === v else { throw APIError(status: -1, message: "Unlock your library first.") }
        version = try JSONDecoder().decode(R.self, from: d).version
        doc = next; revision += 1
        return next
      } catch let e as APIError where e.status == 409 {
        continue
      } catch let e as APIError where e.status == 404 {
        throw APIError(status: e.status, message: Self.oldServer)
      }
    }
    throw APIError(status: -1, message: "Couldn't save. Try again.")
  }

  /** A new review, not saved yet. */
  static func draft() -> Review { Review(id: "", name: "", query: "", every: .week, count: 12, notify: true, created: 0, updated: 0) }

  @discardableResult
  func save(_ r: Review) async throws -> Review {
    var r = r
    if r.id.isEmpty { r.id = Hex.encode(Sodium.random(8)) }
    let id = r.id
    let d = try await change { try CustomReviews.upsertReview($0, r, now: Date().timeIntervalSince1970 * 1000) }
    return d.reviews.first { $0.id == id } ?? r
  }

  func remove(_ id: String) async throws {
    try await change { CustomReviews.deleteReview($0, id: id, now: Date().timeIntervalSince1970 * 1000) }
  }

  /** Remembers that a review was watched now with these photos (once a period; again in the same period changes nothing). */
  func watched(_ r: Review, period: Int, ids: [String]) async {
    if doc.shown[r.id]?.period == period { return }
    _ = try? await change { d in d.reviews.contains { $0.id == r.id } ? CustomReviews.recordShown(d, id: r.id, period: period, ids: ids) : d }
  }

  /** The photos a query finds as Search does: its close matches only, with this Mac's explicit filter, and only those
   *  a review can show. */
  static func matches(_ query: String, library: [Item]) async -> [Item] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return [] }
    return await AppModel.shared.search.search(q, library: library).items.filter(CustomReviews.showable)
  }

  /** What a review plays now: what it played before in this period, else a new pick. */
  func play(_ r: Review, library: [Item], now: Date = Date()) async -> Played {
    let matches = await Self.matches(r.query, library: library)
    let period = CustomReviews.periodOf(r.every, now)
    let picked = CustomReviews.replayed(doc, id: r.id, period: period, matches: matches)
      ?? CustomReviews.pickReview(matches, count: r.count, shown: doc.shown[r.id]?.ids ?? [], seed: CustomReviews.seedOf(r.id, period))
    return Played(review: r, period: period, picked: picked, total: matches.count, slides: CustomReviews.slides(r, picked: picked, total: matches.count))
  }

  func review(_ id: String) -> Review? { doc.reviews.first { $0.id == id } }
  func isDue(_ r: Review, now: Date = Date()) -> Bool { CustomReviews.isDue(r, doc, now: now) }
}

// ---- words ----

enum ReviewWords {
  static func often(_ e: Review.Every) -> String {
    switch e { case .day: return "Daily"; case .week: return "Weekly"; case .month: return "Monthly" }
  }

  /** "Daily · 12 photos" */
  static func summary(_ r: Review) -> String { "\(often(r.every)) · \(r.count) photos" }

  /** The period a story is of: "Today", "This week", "November". */
  static func period(_ e: Review.Every, now: Date = Date()) -> String {
    switch e {
    case .day: return "Today"
    case .week: return "This week"
    case .month: return Calendar.current.standaloneMonthSymbols[Calendar.current.component(.month, from: now) - 1]
    }
  }

  /** "Next one tomorrow" */
  static func nextOne(_ e: Review.Every) -> String {
    switch e { case .day: return "Next one tomorrow"; case .week: return "Next one next week"; case .month: return "Next one next month" }
  }

  /** "Due now", "Next: tomorrow", "Next: Monday", "Next: 1 December" */
  static func status(_ r: Review, _ doc: ReviewDoc, now: Date = Date()) -> String {
    if CustomReviews.isDue(r, doc, now: now) { return "Due now" }
    let next = CustomReviews.nextDue(r, doc, now: now)
    let cal = Calendar.current
    if cal.isDate(next, inSameDayAs: cal.date(byAdding: .day, value: 1, to: now) ?? now) { return "Next: tomorrow" }
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate(next.timeIntervalSince(now) < 6 * 86_400 ? "EEEE" : "dMMMM")
    return "Next: \(f.string(from: next))"
  }

  static func matching(_ n: Int) -> String { n == 0 ? "No photos match" : n == 1 ? "1 photo matches" : "\(n) photos match" }
}

// ---- Settings › General › Memories › Custom reviews ----

/** The list of reviews and the editor, as one sheet. `start`: open this review's editor at once (from a story's end). */
struct CustomReviewsSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var start: String?
  @State private var editing: Review?

  private var store: ReviewStore { model.reviews }

  var body: some View {
    Group {
      if let e = editing {
        ReviewEditor(review: e) { editing = nil; if start != nil { dismiss() } }
      } else {
        list
      }
    }
    .padding(24).frame(width: 480)
    .background(Ink.card)
    .task {
      await store.ensure()
      if let s = start, let r = store.review(s) { editing = r }
    }
  }

  private var list: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Custom reviews").font(Typo.dialog)
      Text("A search you save, played as a story every day, week or month, with different photos each time. Synced between your devices, end-to-end encrypted: the server never learns what a review searches for.")
        .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
      if model.vault == nil {
        NeedsUnlock()
      } else if !store.loaded {
        if let p = store.problem { Text(p).font(Typo.caption).foregroundStyle(Ink.danger) } else { ProgressView().controlSize(.small) }
      } else if store.doc.reviews.isEmpty {
        Text("No reviews yet.").font(Typo.body).foregroundStyle(Ink.faint)
      } else {
        ScrollView {
          VStack(spacing: 0) {
            ForEach(store.doc.reviews) { r in
              Button { editing = r } label: { row(r) }.buttonStyle(.plain)
              if r.id != store.doc.reviews.last?.id { Divider() }
            }
          }
        }
        .frame(maxHeight: 320)
      }
      HStack {
        Button("New Review…") { editing = ReviewStore.draft() }
          .buttonStyle(SecondaryButton())
          .disabled(model.vault == nil || !store.loaded || store.doc.reviews.count >= CustomReviews.maxReviews)
        Spacer()
        Button("Done") { dismiss() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
      }
    }
  }

  private func row(_ r: Review) -> some View {
    let due = store.isDue(r)
    return HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(r.name).font(Typo.label).foregroundStyle(Ink.ink).lineLimit(1)
        Text(ReviewWords.summary(r)).font(Typo.caption).foregroundStyle(Ink.muted)
      }
      Spacer()
      Text(ReviewWords.status(r, store.doc)).font(Typo.caption).foregroundStyle(due ? Ink.teal : Ink.muted)
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(Ink.faint)
    }
    .padding(.vertical, 10)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/** New or changed review: what to search for (with how many photos match, live), how often, how many photos, a name. */
struct ReviewEditor: View {
  @Environment(AppModel.self) private var model
  @State var review: Review
  let done: () -> Void
  @State private var matches: Int?
  @State private var busy = false
  @State private var problem: String?
  @State private var confirmDelete = false

  private var isNew: Bool { review.id.isEmpty }
  private var query: String { review.query.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(isNew ? "New review" : "Edit review").font(Typo.dialog)
      VStack(alignment: .leading, spacing: 4) {
        Text("Search for").font(Typo.label)
        TextField("beach, Anna, 2023, videos…", text: $review.query).textFieldStyle(.roundedBorder)
        Group {
          if query.isEmpty { Text("Words, people, places and dates work as in Search.") }
          else if let n = matches { Text(ReviewWords.matching(n)) }
          else { Text("Searching…") }
        }
        .font(Typo.caption).foregroundStyle(matches == 0 && !query.isEmpty ? Ink.danger : Ink.muted)
      }
      VStack(alignment: .leading, spacing: 4) {
        Text("How often").font(Typo.label)
        Picker("How often", selection: $review.every) {
          ForEach(Review.Every.allCases, id: \.self) { Text(ReviewWords.often($0)).tag($0) }
        }.pickerStyle(.segmented).labelsHidden()
      }
      VStack(alignment: .leading, spacing: 4) {
        Text("Photos").font(Typo.label)
        Picker("Photos", selection: $review.count) {
          ForEach(CustomReviews.counts, id: \.self) { Text("\($0)").tag($0) }
        }.pickerStyle(.segmented).labelsHidden()
      }
      VStack(alignment: .leading, spacing: 4) {
        Text("Name").font(Typo.label)
        TextField(query.isEmpty ? "Name" : query, text: $review.name).textFieldStyle(.roundedBorder)
      }
      if let problem { Text(problem).font(Typo.caption).foregroundStyle(Ink.danger).fixedSize(horizontal: false, vertical: true) }
      HStack {
        if !isNew {
          Button("Delete…", role: .destructive) { confirmDelete = true }.buttonStyle(SecondaryButton()).disabled(busy)
        }
        Spacer()
        Button("Cancel") { done() }.buttonStyle(SecondaryButton()).keyboardShortcut(.cancelAction)
        Button { save() } label: { BusyLabel(busy, "Save", "Saving…") }
          .buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
          .disabled(busy || query.isEmpty)
      }
    }
    .task(id: query) {
      matches = nil
      guard !query.isEmpty else { return }
      try? await Task.sleep(for: .milliseconds(300))
      if Task.isCancelled { return }
      let n = await ReviewStore.matches(query, library: model.items).count
      if !Task.isCancelled { matches = n }
    }
    .confirmationDialog("Delete “\(review.name.isEmpty ? query : review.name)”?", isPresented: $confirmDelete) {
      Button("Delete Review", role: .destructive) { remove() }
      Button("Cancel", role: .cancel) {}
    } message: { Text("It's deleted on all your devices. Your photos stay.") }
  }

  private func save() {
    busy = true; problem = nil
    Task {
      defer { busy = false }
      do { try await model.reviews.save(review); done() } catch { problem = error.localizedDescription }
    }
  }

  private func remove() {
    busy = true; problem = nil
    Task {
      defer { busy = false }
      do { try await model.reviews.remove(review.id); done() } catch { problem = error.localizedDescription }
    }
  }
}
