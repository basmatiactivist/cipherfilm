// Search and people while the library is unlocked: keeps the decrypted index in memory, fetches the entries other
// devices made, and indexes every photo and video that has none yet, in the background, also with the window closed.
// Each entry is computed from the item's decrypted preview, sealed to the account's public key and stored on the
// server, so it is computed once per photo, not once per device; the phone reads what the Mac made and the reverse.
import Foundation
import IOKit.ps
import Observation
import CipherfilmCore

@MainActor @Observable
final class SearchEngine {
  enum Phase: Equatable { case off, download, loading, indexing, waitPower, ready, error }
  var phase: Phase = .off
  var done = 0
  var total = 0
  var message: String?
  /** while downloading the models: bytes a second (smoothed), and why it is waiting to try again after a drop */
  var rate: Double = 0
  var retry: (reason: String, seconds: Int)?
  private var rateAt: (time: Date, bytes: Int)?
  /** bumped when the index or the people document changed */
  var version = 0

  let index = SearchIndex()
  let models = ModelStore(dir: Paths.models)
  private var vision: Vision?
  private var visionFaces = false
  private var visionClip = ClipModel.mobileclip
  private var visionReader = false
  private var tokenizer: Tokenizer?
  private var tags: [String: String] = [:]
  private var run: Task<Void, Never>?
  private var runVault: Vault?
  private var runFaces = false
  /** the model this run uses: LAION only while an admin allows it and the account chose it */
  private(set) var clip = ClipModel.mobileclip
  /** whether this Mac computes the index; otherwise another device does and this one only reads it (and keeps only
   *  the text model, to turn search words into a vector) */
  private(set) var indexes = true
  /** what the run is doing, for an error message ("Fetching the index from the server: …") */
  private var step = ""
  private var pending: [Item] = []
  // being indexed now, and skipped in this run (can't be read): a library refresh while they are in flight must not
  // queue them again (they were indexed and counted twice: "Indexing 43 of 29")
  private var inFlight: Set<String> = []
  private var skipped: Set<String> = []
  private var indexedThisRun = 0
  private var items: [Item] = []
  private var settings = AccountSettings()

  var ready: Bool { phase == .ready || phase == .indexing || phase == .waitPower }

  // ---- the run ----

  func libraryChanged(vault: Vault, items: [Item], settings: AccountSettings) {
    self.items = items
    self.settings = settings
    guard settings.search else {
      // turned off here: another device indexes from now on (the server drops it only if it was this Mac)
      if phase != .off { stop(clear: true); Task { try? await vault.api.json("DELETE", "/api/me/indexer") } }
      return
    }
    if runVault === vault && runFaces == settings.faces && run != nil {
      queueMissing() // the running loop picks these up
      return
    }
    stop(clear: runVault !== vault || runFaces != settings.faces)
    runVault = vault
    runFaces = settings.faces
    let faces = settings.faces
    run = Task { await self.start(vault: vault, faces: faces) }
  }

  func stop(clear: Bool) {
    run?.cancel(); run = nil
    if clear {
      index.clear(); tags = [:]; runVault = nil; people = PeopleDoc(); peopleVersion = 0; peopleLoaded = false; groupsAt = -1; groups = []
      version += 1
    }
    phase = .off; done = 0; total = 0; message = nil; skipped = []
  }

  private func live(_ v: Vault) -> Bool { !Task.isCancelled && runVault === v && v.isOpen }

  private func start(vault: Vault, faces: Bool) async {
    do {
      // which model: the people document holds the account's choice, the server whether it is allowed; and whether
      // this Mac computes the index or only reads what another device computes (docs/SEARCH.md, "One device indexes")
      phase = .loading
      step = "Loading your search settings"
      await refreshMe(vault.api)
      try await loadPeople()
      guard live(vault) else { return }
      let allowed = AppModel.shared.me?.user.nsfw == true
      clip = ClipModel.choose(allowed: allowed, explicit: people.explicit == true)
      indexes = AppModel.shared.me?.mayIndex ?? true
      if AppModel.shared.settings.explicitSeen != (people.explicit == true) { AppModel.shared.settings.explicitSeen = people.explicit == true }
      // the other model's two files go before the chosen one is fetched (tokenizer and face models are shared); a
      // Mac that only reads keeps just the text model
      models.remove(clip == .laion ? .mobileclip : .laion)
      if !indexes { models.removeIndexing() }
      let clip = clip, reader = !indexes
      step = "Downloading the search models"
      if !models.have(faces: faces, clip: clip, reader: reader) {
        phase = .download; done = 0; total = Int(models.missingBytes(faces: faces, clip: clip, reader: reader)); message = nil; rate = 0; rateAt = nil; retry = nil
        try await models.download(faces: faces, clip: clip, reader: reader) { p in Task { @MainActor in self.downloaded(p) } }
        guard live(vault) else { return }
      }
      phase = .loading
      step = "Opening the search models"
      if vision == nil || visionFaces != faces || visionClip != clip || visionReader != reader {
        let dir = models.dir
        vision = nil
        vision = try await Task.detached(priority: .utility) { try Vision(dir: dir, faces: faces, clip: clip, threads: 4, textOnly: reader) }.value
        visionFaces = faces; visionClip = clip; visionReader = reader
      }
      guard live(vault) else { return }
      let pair = try vault.pair()
      let pk = try vault.checkedPublicKey()

      // what the server has for this model: everything new since the last visit, added to the encrypted copy kept in
      // the cache (one per model, so switching back doesn't fetch the whole index again)
      step = "Fetching the index from the server"
      var cache = IndexCache.read(vault, clip.family)
      try await pull(vault, &cache, pair: pair, faces: faces, all: true)
      guard live(vault) else { return }

      // what has no entry yet, newest first: six photos in flight at once (downloading the preview is the slow part;
      // the models take about 65 ms a photo), each one stored on the server as soon as it is done, so a stop or quit
      // loses at most the photos in flight. A Mac that only reads fetches what the indexing device adds instead.
      step = "Indexing"
      queueMissing()
      var lastBump = Date.distantPast
      var idleRounds = 0
      var sinceWrite = 0
      while live(vault) {
        if pending.isEmpty {
          if phase == .indexing && indexedThisRun >= 20 { Notifier.post("Search is ready", "\(indexedThisRun) photos and videos indexed.") }
          if indexedThisRun > 0 { version += 1 }
          indexedThisRun = 0
          phase = .ready
          if indexes { done = total }
          cache.write(vault, clip.family)
          try await Task.sleep(nanoseconds: 3_000_000_000)
          // another device may have turned explicit search on or off, an admin changed the permission, or the
          // person chose another device to index (or this one)
          idleRounds += 1
          if idleRounds % 20 == 0 {
            await refreshMe(vault.api)
            if (try? await loadPeople()) != nil, live(vault),
               ClipModel.choose(allowed: AppModel.shared.me?.user.nsfw == true, explicit: people.explicit == true) != clip
                || (AppModel.shared.me?.mayIndex ?? true) != indexes {
              restart(); return
            }
            if !indexes, live(vault) { try? await pull(vault, &cache, pair: pair, faces: faces, all: false); queueMissing() }
          }
          continue
        }
        if !settings.indexOnBattery && Power.onBattery() {
          phase = .waitPower; message = "Waiting for power. To index on battery, change it in Settings › Search."
          try await Task.sleep(nanoseconds: 30_000_000_000)
          continue
        }
        phase = .indexing; message = nil
        let v = vision!
        let batch = Array(pending.prefix(48))
        pending.removeFirst(batch.count)
        var offlineCount = 0
        var lastOffline: String?
        var refused = false
        inFlight = Set(batch.map(\.id))
        defer { inFlight = [] } // also the ones a refusal left unstarted
        await withTaskGroup(of: (Item, IndexEntry?, String?, APIError?).self) { g in
          var it = batch.makeIterator()
          func next() {
            guard let item = it.next() else { return }
            g.addTask(priority: .utility) {
              do {
                let pic = try await vault.bestPicture(of: item)
                let e = try await Task.detached(priority: .utility) { IndexEntry(analysis: try v.analyze(pic, faces: faces), faces: faces, model: clip) }.value
                let enc = B64.encode(try e.seal(pk: pk, itemId: item.id))
                try await Self.put(enc, model: e.m, item: item.id, api: vault.api)
                return (item, e, enc, nil)
              } catch {
                return (item, nil, nil, (error as? APIError) ?? APIError(status: -1, message: error.localizedDescription))
              }
            }
          }
          for _ in 0..<6 { next() }
          for await (item, e, enc, err) in g {
            inFlight.remove(item.id)
            if let e, let enc {
              let d = e.decoded(faces: faces)
              index.put(item.id, clip: d.clip, faces: d.faces)
              tags[item.id] = e.m
              cache.entries[item.id] = enc
              done += 1; indexedThisRun += 1; sinceWrite += 1
            } else if err?.code == "not_indexer" {
              refused = true // another device indexes now: this Mac only reads from here on
            } else if err?.status == 0 {
              pending.insert(item, at: 0); offlineCount += 1; lastOffline = err?.message // tried again on the next round
            } else {
              skipped.insert(item.id); done += 1 // can't be read: skipped this run
            }
            if live(vault) && !refused { next() }
          }
        }
        if refused {
          cache.write(vault, clip.family)
          await refreshMe(vault.api)
          restart(); return
        }
        // screens that show people or search results are worked out again at most every few seconds
        if Date().timeIntervalSince(lastBump) > 4 { version += 1; lastBump = Date() }
        if sinceWrite >= 20 { cache.write(vault, clip.family); sinceWrite = 0 }
        if offlineCount == batch.count {
          phase = .error; message = "Couldn't load photos to index: \(lastOffline ?? APIError.offline) Trying again in 30 s."
          try await Task.sleep(nanoseconds: 30_000_000_000)
        }
      }
    } catch is CancellationError {
    } catch {
      if live(vault) { phase = .error; message = "\(step): \(error.localizedDescription) Trying again in a minute." }
      // try again in a while (offline, server busy)
      try? await Task.sleep(nanoseconds: 60_000_000_000)
      if live(vault) { run = Task { await self.start(vault: vault, faces: faces) } }
    }
  }

  /** Fetches the server's entries for the active model since the cache's last visit and opens them into the index;
   *  all: the whole cache (at the start), otherwise only what is new. */
  private func pull(_ vault: Vault, _ cache: inout IndexCache, pair: KeyPair, faces: Bool, all: Bool) async throws {
    var after = ""
    var fresh: [String: String] = [:]
    var pages = 0, got = 0
    while true {
      struct Page: Decodable { struct E: Decodable { let item_id: String; let data_enc: String; let updated_at: Int64 }; let entries: [E]; let next: String? }
      let q = after.isEmpty ? "since=\(cache.since)" : "after=" + (after.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? after)
      let page = try await vault.api.get(Page.self, "/api/index?model=\(clip.family)&\(q)")
      for e in page.entries { cache.entries[e.item_id] = e.data_enc; fresh[e.item_id] = e.data_enc; cache.since = max(cache.since, e.updated_at) }
      pages += 1; got += page.entries.count
      guard let n = page.next, !n.isEmpty else { break }
      guard pages < Vault.maxListPages, got <= Vault.maxListItems, n != after else { throw APIError(status: -1, message: "The server's index list doesn't end.") }
      after = n
    }
    if !all && fresh.isEmpty { return }
    cache.write(vault, clip.family)
    let ids = Set(items.map(\.id))
    let entries = all ? cache.entries : fresh
    let idx = index, clip = clip
    let opened = await Task.detached(priority: .utility) { () -> ([String: String], [String]) in
      var tags: [String: String] = [:]
      var bad: [String] = []
      for (id, enc) in entries where ids.contains(id) {
        guard let blob = try? B64.decode(enc), let e = try? IndexEntry.open(blob, pair: pair, itemId: id) else { bad.append(id); continue }
        let d = e.decoded(faces: faces)
        // a vector from the other model can't be compared with this one's: kept out until it is made again
        idx.put(id, clip: clip.owns(e.m) ? d.clip : nil, faces: d.faces)
        tags[id] = e.m
      }
      return (tags, bad)
    }.value
    tags.merge(opened.0) { _, b in b }
    for id in opened.1 { cache.entries.removeValue(forKey: id) } // damaged or not for this item: made again
    for id in tags.keys where !ids.contains(id) { tags.removeValue(forKey: id); index.remove(id) }
    version += 1
  }

  /** The account as the server sees it now: who indexes, whether explicit search is allowed. */
  private func refreshMe(_ api: API) async {
    if let d = try? await api.json("GET", "/api/me"), let fresh = try? JSONDecoder().decode(Me.self, from: d),
       fresh.user.id == AppModel.shared.me?.user.id { AppModel.shared.me = fresh }
  }

  private func downloaded(_ p: ModelStore.Progress) {
    guard phase == .download else { return }
    let now = Date()
    if let (t, b) = rateAt, p.retry == nil, now.timeIntervalSince(t) >= 1 {
      let r = Double(Int(p.done) - b) / now.timeIntervalSince(t)
      if r >= 0 { rate = rate == 0 ? r : rate * 0.7 + r * 0.3 }
      rateAt = (now, Int(p.done))
    } else if rateAt == nil || p.retry != nil {
      rateAt = (now, Int(p.done))
    }
    done = Int(p.done); total = Int(p.total); retry = p.retry
  }

  /** What using `clip` would download on this Mac now, from the files actually missing (a Mac that only reads needs
   *  just the text model): "about 248 MB", or nil when they are all here. */
  func downloadSize(_ clip: ClipModel, faces: Bool) -> String? {
    let n = models.missingBytes(faces: faces, clip: clip, reader: !(AppModel.shared.me?.mayIndex ?? true))
    return n == 0 ? nil : "about \(max(1, Int((Double(n) / 1e6).rounded()))) MB"
  }

  /** "Downloading search models · 40 of 250 MB · 280 KB/s, about 13 min left", or why it is waiting. */
  var downloadText: String {
    let of = "\(bytes(Int64(done))) of \(bytes(Int64(total)))"
    if let r = retry { return "\(r.reason) Trying again in \(r.seconds) s · \(of)" }
    guard rate > 1024 else { return "Downloading search models · \(of)" }
    let left = Double(total - done) / rate
    let eta = left < 90 ? "less than 2 min left" : left < 5400 ? "about \(Int((left / 60).rounded())) min left" : "about \(Int((left / 3600).rounded())) h left"
    return "Downloading search models · \(of) · \(bytes(Int64(rate)))/s, \(eta)"
  }

  private func queueMissing() {
    guard indexes else {
      total = items.filter { $0.kind != .other && !$0.broken }.count
      done = min(total, items.filter { Models.good(tags[$0.id], faces: runFaces, clip: clip) }.count)
      return
    }
    let queued = Set(pending.map(\.id)).union(inFlight).union(skipped)
    let todo = items.filter { !$0.broken && $0.itemKey != nil && $0.kind != .other && ($0.hasPreview || $0.hasThumb) && !Models.good(tags[$0.id], faces: runFaces, clip: clip) && !queued.contains($0.id) }
    pending += todo
    total = items.filter { $0.kind != .other && !$0.broken }.count
    done = min(total, max(0, total - pending.count - inFlight.count))
  }

  /** Starts the run again from the server's entries, for another model: entries made with the other one are made
   *  again (by whichever device gets to them first). */
  func restart() {
    guard let v = runVault else { return }
    let faces = runFaces
    stop(clear: true)
    runVault = v; runFaces = faces
    run = Task { await self.start(vault: v, faces: faces) }
  }

  /** The person's choice of explicit search, saved in the people document for all their devices; this Mac switches
   *  models and indexes the library again. */
  func setExplicit(_ on: Bool) async throws {
    let old = clip
    try await change { d in d.explicit = on ? true : nil }
    AppModel.shared.settings.explicitSeen = on
    if let v = runVault { await dropFamily(ClipModel.choose(allowed: AppModel.shared.me?.user.nsfw == true, explicit: on) == old ? nil : old, vault: v) }
    restart()
  }

  /** After a switch of model: the old model's entries go (on the server, for every device, and here); the indexing
   *  device makes the new model's. */
  private func dropFamily(_ old: ClipModel?, vault: Vault) async {
    guard let old else { return }
    try? await vault.api.json("DELETE", "/api/index?model=\(old.family)")
    IndexCache.delete(vault, old.family)
  }

  /** Turning search on where explicit search is allowed: the choice of model goes into the people document first, so
   *  only the chosen model is downloaded. */
  func choose(explicit: Bool, vault: Vault) async throws {
    let allowed = AppModel.shared.me?.user.nsfw == true
    for attempt in 0..<5 {
      var (doc, version) = try await People.load(vault)
      if (doc.explicit == true) == explicit { break }
      let old = ClipModel.choose(allowed: allowed, explicit: doc.explicit == true)
      doc.explicit = explicit ? true : nil
      do {
        _ = try await People.save(vault, doc, version: version)
        await dropFamily(old == ClipModel.choose(allowed: allowed, explicit: explicit) ? nil : old, vault: vault)
        break
      } catch let e as APIError where e.status == 409 && attempt < 4 { continue }
    }
    AppModel.shared.settings.explicitSeen = explicit
  }

  /** Turns search off on this Mac; with clearServer also the index and the people list on the server (all devices). */
  func forget(clearServer: Bool, api: API?) async throws {
    let v = runVault
    // another device indexes from now on (the server keeps it only while it is this one's)
    if let api { try? await api.json("DELETE", "/api/me/indexer") }
    stop(clear: true)
    vision = nil
    if let v { IndexCache.delete(v) }
    models.delete()
    if clearServer, let api {
      try await api.json("DELETE", "/api/index")
      try? await api.json("DELETE", "/api/me/blobs/people")
    }
  }

  /** The person chose this Mac to compute the index (Settings › Search): it downloads the image models and indexes,
   *  and the device that did so far only reads from then on. */
  func indexHere(api: API) async throws {
    try await api.json("PUT", "/api/me/indexer")
    await refreshMe(api)
    restart()
  }

  struct Device: Decodable, Equatable { let id: String; let device: String; let last_seen: Int64; let current: Bool; let indexer: Bool }

  /** The account's indexing device, for the settings ("Indexed by …"); nil when there is none (or the server is
   *  older than 1.9.0). */
  func indexingDevice(api: API) async -> Device? {
    struct List: Decodable { let sessions: [Device] }
    return (try? await api.get(List.self, "/api/me/sessions"))?.sessions.first { $0.indexer }
  }

  // ---- for uploads from watched folders: index the file while it is at hand (no master key needed) ----

  nonisolated static func indexFile(_ url: URL, id: String, video: Bool, faces: Bool, clip: ClipModel, pk: Data, api: API) async {
    let store = ModelStore(dir: Paths.models)
    guard store.have(faces: faces, clip: clip), let img = await Media.jpeg(url, video: video, maxPx: 2048, quality: 0.9),
          let v = try? Vision(dir: Paths.models, faces: faces, clip: clip, threads: 2), let a = try? v.analyze(img.data, faces: faces) else { return }
    let entry = IndexEntry(analysis: a, faces: faces, model: clip)
    guard let enc = try? entry.seal(pk: pk, itemId: id) else { return }
    try? await put(B64.encode(enc), model: entry.m, item: id, api: api)
  }

  /** Stores a sealed entry with its model tag in the clear: where explicit search is allowed the server refuses entries
   *  without it, so an older app can't overwrite the other model's entries. A server from before that (1.7.4 and
   *  older) refuses the unknown field with 400 and gets the entry without it. */
  nonisolated static func put(_ enc: String, model: String, item: String, api: API) async throws {
    do {
      try await api.json("PUT", "/api/items/\(item)/index", body: ["data_enc": enc, "model": model])
    } catch let e as APIError where e.status == 400 {
      try await api.json("PUT", "/api/items/\(item)/index", body: ["data_enc": enc])
    }
  }

  // ---- queries ----

  /** ranked: the items are ordered by how well they match the words, not by date */
  struct Result { var items: [Item]; var people: [Group]; var how: [String]; var ranked = false }

  /** Every photo with an image vector from the active model, best match first, with no cut-off (as Immich's smart
   *  search ranks); the results page shows them a page at a time. */
  func textHits(_ q: String) async -> [Hit] {
    guard ready, let vision else { return [] }
    if tokenizer == nil { tokenizer = try? Tokenizer(json: Data(contentsOf: models.dir.appendingPathComponent("mobileclip-s2-tokenizer.json"))) }
    guard let t = tokenizer else { return [] }
    let idx = index
    return await Task.detached(priority: .userInitiated) {
      guard let vec = try? vision.textVector(t.encode(q)) else { return [] }
      return idx.search(vec, limit: Int.max, minScore: -2)
    }.value
  }

  func similar(to id: String) -> [String] { ready ? index.similar(id, limit: 60, minScore: 0.6).map(\.id) : [] }

  /** One search box for everything the Mac knows about a photo (port of mobile/src/search/query.ts). */
  func search(_ raw: String, library: [Item], favoritesOnly: Bool = false) async -> Result {
    let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return Result(items: [], people: [], how: []) }
    var how: [String] = []
    let lower = q.lowercased()
    var pool = library.filter { !$0.broken }
    let gs = await peopleGroups()
    let people = gs.filter { g in
      guard let p = g.person, !p.name.isEmpty, p.hidden != true else { return false }
      return p.name.lowercased().split(separator: " ").contains { w in w.hasPrefix(lower) || lower.split(separator: " ").contains(w) }
    }
    var words = lower.split(whereSeparator: \.isWhitespace).map(String.init)
    if !people.isEmpty {
      let ids = Set(people.flatMap(\.items))
      pool = pool.filter { ids.contains($0.id) }
      let names = Set(people.flatMap { $0.person!.name.lowercased().split(separator: " ").map(String.init) })
      words = words.filter { w in !names.contains(w) && !people.contains { $0.person!.name.lowercased().hasPrefix(w) } }
      how.append(people.map { $0.person!.name }.joined(separator: ", "))
    }
    if words.contains(where: Query.isVideoWord) { pool = pool.filter { $0.kind == .video }; words.removeAll(where: Query.isVideoWord); how.append("videos") }
    if words.contains(where: Query.isFavWord) { pool = pool.filter(\.favorite); words.removeAll(where: Query.isFavWord); how.append("favorites") }
    if words.contains(where: Query.isShotWord) {
      pool = pool.filter { $0.name.range(of: "screenshot|bildschirm", options: [.regularExpression, .caseInsensitive]) != nil }
      words.removeAll(where: Query.isShotWord); how.append("screenshots")
    }
    let d = Query.parseDate(words.joined(separator: " "))
    if d.year != nil || d.month != nil {
      let cal = Calendar.current
      pool = pool.filter { i in
        let c = cal.dateComponents([.year, .month, .day], from: i.date)
        if let y = d.year, c.year != y { return false }
        if let m = d.month, c.month != m + 1 { return false }
        if d.day == -1, let day = c.day, day < 20 || day > 27 { return false }
        return true
      }
      let month = d.month.map { DateFormatter().monthSymbols[$0] } ?? ""
      how.append([month, d.year.map(String.init) ?? ""].joined(separator: " ").trimmingCharacters(in: .whitespaces))
    }
    let rest = d.rest
    if rest.isEmpty { return Result(items: pool.sorted { $0.when > $1.when }, people: people, how: how) }
    // a file name or camera that contains the words comes first; then everything else, ranked by what is in it, and
    // the filters above (people, kind, favorites, dates) only narrow that ranking
    let named = pool.filter { $0.name.lowercased().contains(rest) || "\($0.meta?.make ?? "") \($0.meta?.model ?? "")".lowercased().contains(rest) }
    let hits = await textHits(rest)
    let inPool = Dictionary(pool.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var seen = Set<String>()
    var out: [Item] = []
    for i in named where seen.insert(i.id).inserted { out.append(i) }
    for h in hits { if let it = inPool[h.id], seen.insert(it.id).inserted { out.append(it) } }
    if !hits.isEmpty { how.append("“\(rest)”") } else if !named.isEmpty { how.append("named “\(rest)”") }
    return Result(items: out, people: people, how: how, ranked: !hits.isEmpty)
  }

  // ---- people: faces grouped here, the person's decisions in one document encrypted with the master key ----

  struct Group: Identifiable, Hashable {
    let key: String
    let person: Person?
    let items: [String]
    let faces: [String]
    let cover: FaceGroup.Cover?
    var id: String { key }
    var name: String { person?.name ?? "" }
  }

  private(set) var people = PeopleDoc()
  private var peopleVersion = 0
  private var peopleLoaded = false
  private var groups: [Group] = []
  private var allGroups: [Group] = []
  private var groupsAt = -1

  /** Another device changed the people document (live updates): it is read again when the groups are next needed. */
  func peopleChangedElsewhere() {
    guard peopleLoaded else { return }
    peopleLoaded = false; groupsAt = -1; version += 1
  }

  func loadPeople() async throws {
    guard let v = runVault else { return }
    let r = try await People.load(v)
    people = r.doc; peopleVersion = r.version; peopleLoaded = true; groupsAt = -1; version += 1
  }

  func peopleGroups() async -> [Group] {
    guard settings.search, settings.faces, ready else { return [] }
    if !peopleLoaded { try? await loadPeople() }
    if groupsAt == version { return groups }
    let anchors = people.people.map { ($0.id, $0.anchors) }
    let rejects = Dictionary(people.people.map { ($0.id, $0.rejects) }, uniquingKeysWith: { a, _ in a })
    let idx = index
    // every group, also those under three photos: the viewer names the faces in one photo from these
    let raw = await Task.detached(priority: .userInitiated) { idx.cluster(threshold: People.threshold, anchors: anchors, rejects: rejects, minFaces: 1) }.value
    let live = Set(items.map(\.id))
    let byId = Dictionary(people.people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var seen = Set<String>()
    allGroups = raw.enumerated().compactMap { i, g -> Group? in
      let person = g.person.flatMap { byId[$0] }
      let its = g.items.filter { live.contains($0) }
      guard !its.isEmpty else { return nil }
      if let p = person { guard seen.insert(p.id).inserted else { return nil } }
      return Group(key: person?.id ?? "g\(i):\(g.cover?.key ?? "")", person: person, items: its, faces: g.faces, cover: g.cover)
    }
    groups = allGroups.filter { $0.person != nil || $0.items.count >= People.minFaces }
    groupsAt = version
    return groups
  }

  func peopleIn(_ itemId: String) async -> [Group] {
    await peopleGroups().filter { $0.items.contains(itemId) && $0.person?.hidden != true }
  }

  /** Every face found in a photo, with the person or group it belongs to (if any). */
  struct FaceInPhoto: Identifiable { let cover: FaceGroup.Cover; let group: Group?; var id: String { cover.key } }

  func facesIn(_ itemId: String) async -> [FaceInPhoto] {
    _ = await peopleGroups()
    return index.facesOf(itemId).map { f in
      FaceInPhoto(cover: FaceGroup.Cover(key: f.key, item: itemId, box: f.box), group: allGroups.first { $0.faces.contains(f.key) })
    }
  }

  /** Names the person a single face belongs to: the face's group, or a new person made from just this face. */
  @discardableResult
  func name(face: FaceInPhoto, _ name: String) async throws -> String? {
    if let g = face.group { return try await self.name(g, name) }
    let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
    guard !clean.isEmpty else { return nil }
    if let existing = people.people.first(where: { $0.name.lowercased() == clean.lowercased() }) {
      try await change { d in
        guard let k = d.people.firstIndex(where: { $0.id == existing.id }) else { return }
        d.people[k].anchors = Array((d.people[k].anchors + [face.cover.key]).suffix(400))
        d.people[k].rejects.removeAll { $0 == face.cover.key }
      }
      return existing.id
    }
    let id = newId()
    try await change { d in d.people.append(Person(id: id, name: clean, hidden: nil, anchors: [face.cover.key], rejects: [])) }
    return id
  }

  /** Applies a change and saves it; if another device saved in between, the change is applied to theirs. */
  private func change(_ f: (inout PeopleDoc) -> Void) async throws {
    guard let v = runVault else { throw APIError(status: -1, message: "Unlock your library first.") }
    for i in 0..<4 {
      if !peopleLoaded || i > 0 { try await loadPeople() }
      var next = people
      f(&next)
      do {
        peopleVersion = try await People.save(v, next, version: peopleVersion)
        people = next; groupsAt = -1; version += 1
        return
      } catch let e as APIError where e.status == 409 {
        continue
      }
    }
    throw APIError(status: -1, message: "Couldn't save. Try again.")
  }

  private func newId() -> String { Hex.encode(Sodium.random(8)) }

  @discardableResult
  func name(_ g: Group, _ name: String) async throws -> String? {
    let clean = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
    guard !clean.isEmpty else { return nil }
    let faces = Array(g.faces.prefix(People.maxAnchors))
    // a name someone already has: these faces become theirs (no second "Anna")
    if g.person == nil, let same = people.people.first(where: { $0.name.lowercased() == clean.lowercased() }) {
      try await merge(g, into: same)
      return same.id
    }
    let id = g.person?.id ?? newId()
    try await change { d in
      if let k = d.people.firstIndex(where: { $0.id == id }) { d.people[k].name = clean; d.people[k].hidden = false }
      else { d.people.append(Person(id: id, name: clean, hidden: nil, anchors: faces, rejects: [])) }
    }
    guard people.people.first(where: { $0.id == id })?.name == clean else { throw APIError(status: -1, message: "The name wasn't saved. Try again.") }
    return id
  }

  /** "These are the same person": the group's faces become the person's too. */
  func merge(_ g: Group, into p: Person) async throws {
    let faces = Array(g.faces.prefix(People.maxAnchors))
    try await change { d in
      guard let k = d.people.firstIndex(where: { $0.id == p.id }) else { return }
      var seen = Set<String>()
      d.people[k].anchors = Array((d.people[k].anchors + faces).filter { seen.insert($0).inserted }.suffix(400))
      if let gp = g.person, gp.id != p.id { d.people.removeAll { $0.id == gp.id } }
    }
  }

  /** "Not this person" for some photos: their faces in this group leave it. */
  func remove(items: Set<String>, from g: Group) async throws {
    guard let p = g.person else { return }
    let keys = g.faces.filter { k in items.contains(String(k.split(separator: ":").first ?? "")) }
    try await change { d in
      guard let k = d.people.firstIndex(where: { $0.id == p.id }) else { return }
      let out = Set(keys)
      d.people[k].anchors.removeAll { out.contains($0) }
      var seen = Set<String>()
      d.people[k].rejects = Array((d.people[k].rejects + keys).filter { seen.insert($0).inserted }.suffix(2000))
    }
  }

  @discardableResult
  func setHidden(_ g: Group, _ hidden: Bool) async throws -> String {
    let id = g.person?.id ?? newId()
    let faces = Array(g.faces.prefix(People.maxAnchors))
    try await change { d in
      if let k = d.people.firstIndex(where: { $0.id == id }) { d.people[k].hidden = hidden }
      else { d.people.append(Person(id: id, name: "", hidden: hidden, anchors: faces, rejects: [])) }
    }
    return id
  }

  func forget(_ p: Person) async throws { try await change { $0.people.removeAll { $0.id == p.id } } }

  /** The faces of a group, each with where it is, for the person view's face strip. */
  func faces(of g: Group) -> [FaceGroup.Cover] {
    let keys = Set(g.faces)
    var out: [FaceGroup.Cover] = []
    for item in g.items { for f in index.facesOf(item) where keys.contains(f.key) { out.append(FaceGroup.Cover(key: f.key, item: item, box: f.box)) } }
    return out
  }

  /** Moves faces to another person: they leave the group (as "not this person" when it is a named one) and become
   *  that person's. With a name instead of a person, a new person is made from them. */
  func move(faces keys: [String], from g: Group, to target: Person?, newName: String? = nil) async throws {
    guard !keys.isEmpty else { return }
    let newId = newId()
    let clean = newName.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)) }
    try await change { d in
      let set = Set(keys)
      if let from = g.person, let k = d.people.firstIndex(where: { $0.id == from.id }) {
        d.people[k].anchors.removeAll { set.contains($0) }
        var seen = Set<String>()
        d.people[k].rejects = Array((d.people[k].rejects + keys).filter { seen.insert($0).inserted }.suffix(2000))
      }
      if let target, let k = d.people.firstIndex(where: { $0.id == target.id }) {
        d.people[k].rejects.removeAll { set.contains($0) }
        var seen = Set<String>()
        d.people[k].anchors = Array((d.people[k].anchors + keys).filter { seen.insert($0).inserted }.suffix(400))
      } else if let clean, !clean.isEmpty {
        d.people.append(Person(id: newId, name: clean, hidden: nil, anchors: Array(keys.prefix(People.maxAnchors)), rejects: []))
      }
    }
  }
}

/** The server's index entries, kept encrypted in the cache folder so a start needs only what changed. */
/** The server's encrypted entries of one model family, kept between runs so a start fetches only what changed. */
struct IndexCache: Codable {
  var since: Int64 = 0
  var entries: [String: String] = [:]

  static let families = [ClipModel.mobileclip.family, ClipModel.laion.family]
  static func url(_ v: Vault, _ family: String) -> URL? { v.cacheDir?.appendingPathComponent("index-\(family).json") }
  static func read(_ v: Vault, _ family: String) -> IndexCache {
    // before 1.9.0 one file held either model's entries; it is fetched again per model
    if let old = v.cacheDir?.appendingPathComponent("index.json") { try? FileManager.default.removeItem(at: old) }
    return url(v, family).flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(IndexCache.self, from: $0) } ?? IndexCache()
  }
  func write(_ v: Vault, _ family: String) {
    guard let u = Self.url(v, family) else { return }
    try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let d = try? JSONEncoder().encode(self) { try? d.write(to: u, options: .atomic) }
  }
  static func delete(_ v: Vault, _ family: String) { if let u = url(v, family) { try? FileManager.default.removeItem(at: u) } }
  static func delete(_ v: Vault) { for f in families { delete(v, f) } }
}

enum Power {
  /** True on a laptop running from its battery. */
  static func onBattery() -> Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return false }
    return type == kIOPSBatteryPowerValue
  }
}
