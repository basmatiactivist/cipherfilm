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
  /** consent: the models (or some) aren't here and the person hasn't agreed to download them yet (ModelStore,
   *  docs/MODELS.md); total is the download's size. Nothing is fetched until they do. */
  enum Phase: Equatable { case off, consent, download, loading, indexing, waitPower, ready, error }
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
  private var visionReader = false
  private var tokenizer: Tokenizer?
  private var tags: [String: String] = [:]
  private var run: Task<Void, Never>?
  private var runVault: Vault?
  private var runFaces = false
  /** the model: one for everyone (docs/SEARCH.md "One model") */
  let clip = ClipModel.clip
  /** whether search leaves explicit photos and words out (docs/SEARCH.md "Explicit content"): unless an admin allows
   *  explicit search and the account chose it; yes until that is known */
  private(set) var filtered = true
  /** whether this Mac computes the index; otherwise another device does and this one only reads it (and keeps only
   *  the text model, to turn search words into a vector) */
  private(set) var indexes = true
  /** while this Mac only reads: the photos and videos still without an entry from the indexing device (0 while it
   *  indexes itself) */
  private(set) var waiting = 0
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

  // ---- text in photos (Ocr, docs/SEARCH.md "Text in photos") ----
  /** the text model, while this Mac indexes, the setting is on and its files are here */
  private var ocr: Ocr?
  /** each item's text read in it (trimmed; only items with some), from the entries: for search */
  private var texts: [String: String] = [:]
  /** items whose entry was made before text in photos (no `o`): read again, a few at a time, when nothing else runs */
  private var noText: Set<String> = []
  /** read again and failed in this run (the picture can't be loaded): not tried again until the next run */
  private var textSkipped: Set<String> = []
  /** The account was full for an entry with text (413): the reading waits until search starts again. */
  private var textFull = false
  /** when the text model was last tried and couldn't be loaded or downloaded (offline): tried again a minute later */
  private var ocrTriedAt = Date.distantPast
  /** the text model waits for the person's OK to download it: images and faces are indexed meanwhile */
  private(set) var ocrWaiting = false
  /** photos and videos whose text is still to be read (entries from before text in photos) */
  var textLeft: Int { ocr == nil ? 0 : noText.subtracting(textSkipped).count }

  var ready: Bool { phase == .ready || phase == .indexing || phase == .waitPower }

  // ---- the run ----

  func libraryChanged(vault: Vault, items: [Item], settings: AccountSettings) {
    self.items = items
    self.settings = settings
    // gone from the list it is handed (deleted, or moved to the locked folder, which the app never hands over): out of
    // the index at once, so no search, similar photos or people group finds it
    let live = Set(items.map(\.id))
    let gone = tags.keys.filter { !live.contains($0) }
    if !gone.isEmpty {
      for id in gone { tags.removeValue(forKey: id); index.remove(id) }
      groupsAt = -1; version += 1
    }
    guard settings.search else {
      // turned off here: another device indexes from now on (the server drops it only if it was this Mac)
      if phase != .off { stop(clear: true); Task { try? await vault.api.json("DELETE", "/api/me/indexer") } }
      return
    }
    if runVault === vault && runFaces == settings.faces && run != nil {
      textSettingChanged()
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
      index.clear(); tags = [:]; texts = [:]; noText = []; runVault = nil; people = PeopleDoc(); peopleVersion = 0; peopleLoaded = false; groupsAt = -1; groups = []
      // the decrypted items it was handed (with their item keys) and what was queued from them
      items = []; pending = []; inFlight = []
      version += 1
    }
    phase = .off; done = 0; total = 0; waiting = 0; message = nil; skipped = []; textSkipped = []; textFull = false; ocrWaiting = false; ocrTriedAt = .distantPast
  }

  private func live(_ v: Vault) -> Bool { !Task.isCancelled && runVault === v && v.isOpen }

  private func start(vault: Vault, faces: Bool) async {
    do {
      // filtered or not: the people document holds the account's choice, the server whether it is allowed; and whether
      // this Mac computes the index or only reads what another device computes (docs/SEARCH.md, "One device indexes")
      phase = .loading
      step = "Loading your search settings"
      adoptLibrary()
      await refreshMe(vault.api)
      try await loadPeople()
      guard live(vault) else { return }
      filtered = !Explicit.unfiltered(allowed: AppModel.shared.me?.user.nsfw == true, chosen: people.explicit == true)
      indexes = AppModel.shared.me?.mayIndex ?? true
      // a Mac that only reads keeps just the text model
      if !indexes { models.removeIndexing() }
      let clip = clip, reader = !indexes
      step = "Downloading the search models"
      if !models.have(faces: faces, clip: clip, reader: reader) {
        // asked first (a model update, explicit search, faces or indexing here need new files): nothing goes out before
        if !models.unagreed(faces: faces, clip: clip, reader: reader).isEmpty {
          phase = .consent; done = 0; total = Int(models.missingBytes(faces: faces, clip: clip, reader: reader)); message = nil
          return
        }
        phase = .download; done = 0; total = Int(models.missingBytes(faces: faces, clip: clip, reader: reader)); message = nil; rate = 0; rateAt = nil; retry = nil
        try await models.download(faces: faces, clip: clip, reader: reader) { p in Task { @MainActor in self.downloaded(p) } }
        guard live(vault) else { return }
      }
      phase = .loading
      step = "Opening the search models"
      if vision == nil || visionFaces != faces || visionReader != reader {
        let dir = models.dir
        vision = nil
        vision = try await Task.detached(priority: .utility) { try Vision(dir: dir, faces: faces, clip: clip, threads: 4, textOnly: reader) }.value
        visionFaces = faces; visionReader = reader
      }
      guard live(vault) else { return }
      if indexes { await ensureOcr() } else { ocr = nil }
      guard live(vault) else { return }
      let pair = try vault.pair()
      let pk = try vault.checkedPublicKey()

      // what the server has for this model: everything new since the last visit, added to the encrypted copy kept in
      // the cache
      step = "Fetching the index from the server"
      var cache = IndexCache.read(vault, clip.family)
      try await pull(vault, &cache, pair: pair, faces: faces, all: true)
      guard live(vault) else { return }
      // what was queued before the server's entries were read (the library arriving meanwhile) and has one by now
      pending.removeAll { Models.good(tags[$0.id], faces: faces, clip: clip) }
      // MobileCLIP's entries left from before (docs/SEARCH.md "One model"): read by the Mac that indexes, while photos
      // are missing the new entry, for their faces (no face looked for twice; the people document's names stay)
      let old = ClipModel.legacyFamily
      var legacy = IndexCache()
      queueMissing()
      if indexes && !pending.isEmpty {
        legacy = IndexCache.read(vault, old)
        _ = try? await fetch(vault, &legacy, family: old)
        legacy.write(vault, old)
        guard live(vault) else { return }
      }

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
          // everything has the new entry: what is left of MobileCLIP's goes, on the server and here
          if indexes && !legacy.entries.isEmpty && inFlight.isEmpty {
            if (try? await vault.api.json("DELETE", "/api/index?model=\(old)")) != nil { legacy = IndexCache(); IndexCache.delete(vault, old) }
          }
          // entries from before text in photos: their text, a few at a time, when nothing else is to do
          if indexes && settings.textInPhotos && ocr == nil && !ocrWaiting && Date().timeIntervalSince(ocrTriedAt) > 60 { await ensureOcr() }
          var read = 0
          if indexes, let o = ocr, settings.indexOnBattery || !Power.onBattery() {
            read = await readTextAgain(vault, &cache, ocr: o, pair: pair, pk: pk) // written with the cache next round
          }
          // while there is text to read, the next few come sooner
          try await Task.sleep(nanoseconds: read > 0 ? 500_000_000 : 3_000_000_000)
          // the library may have arrived or changed without being handed over (search turned on before it loaded)
          if adoptLibrary() { if !indexes { try? await pull(vault, &cache, pair: pair, faces: faces, all: true) }; queueMissing(); continue }
          // another device may have turned explicit search on or off, an admin changed the permission, or the
          // person chose another device to index (or this one)
          idleRounds += 1
          if idleRounds % 20 == 0 {
            await refreshMe(vault.api)
            if (try? await loadPeople()) != nil, live(vault) {
              let f = !Explicit.unfiltered(allowed: AppModel.shared.me?.user.nsfw == true, chosen: people.explicit == true)
              if f != filtered { filtered = f; version += 1 }
            }
            if live(vault), (AppModel.shared.me?.mayIndex ?? true) != indexes {
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
        let o = settings.textInPhotos ? ocr : nil
        let batch = Array(pending.prefix(48))
        pending.removeFirst(batch.count)
        var offlineCount = 0
        var lastOffline: String?
        var refused = false
        inFlight = Set(batch.map(\.id))
        defer { inFlight = [] } // also the ones a refusal left unstarted
        // per photo: the faces of its MobileCLIP entry from before, if it has one with faces (the people document names
        // faces by their place in an entry, so they stay the same, and they aren't looked for again)
        var plans: [String: (want: [ClipModel], known: [IndexEntry.Face]?)] = [:]
        for item in batch {
          let e = faces ? legacy.entries[item.id].flatMap { try? B64.decode($0) }.flatMap { try? IndexEntry.open($0, pair: pair, itemId: item.id) } : nil
          plans[item.id] = ([clip], ClipModel.legacyFaces(e?.m) ? e?.faces ?? [] : nil)
        }
        await withTaskGroup(of: (Item, [(IndexEntry, String)], APIError?).self) { g in
          var it = batch.makeIterator()
          func next() {
            guard let item = it.next() else { return }
            let (want, known) = plans[item.id] ?? ([clip], nil)
            g.addTask(priority: .utility) {
              var stored: [(IndexEntry, String)] = []
              do {
                let pic = try await vault.bestPicture(of: item)
                let es = try await Task.detached(priority: .utility) { IndexEntry.entries(try v.analyze(pic, faces: faces && known == nil, clips: want, ocr: o), faces: faces, known: known) }.value
                for e in es {
                  let enc = B64.encode(try e.seal(pk: pk, itemId: item.id))
                  try await Self.put(enc, model: e.m, item: item.id, api: vault.api)
                  stored.append((e, enc))
                }
                return (item, stored, nil)
              } catch {
                return (item, stored, (error as? APIError) ?? APIError(status: -1, message: error.localizedDescription))
              }
            }
          }
          for _ in 0..<6 { next() }
          for await (item, stored, err) in g {
            inFlight.remove(item.id)
            for (e, enc) in stored {
              let d = e.decoded(faces: faces)
              index.put(item.id, clip: d.clip, faces: d.faces)
              tags[item.id] = e.m
              noteText(item.id, e)
              cache.entries[item.id] = enc
              legacy.entries.removeValue(forKey: item.id) // the server replaced it
            }
            if err == nil {
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
          legacy.write(vault, old)
          await refreshMe(vault.api)
          restart(); return
        }
        // screens that show people or search results are worked out again at most every few seconds
        if Date().timeIntervalSince(lastBump) > 4 { version += 1; lastBump = Date() }
        if sinceWrite >= 20 { cache.write(vault, clip.family); legacy.write(vault, old); sinceWrite = 0 }
        if offlineCount == batch.count {
          phase = .error; message = "Couldn't load photos to index: \(lastOffline ?? APIError.offline) Trying again in 30 s."
          try await Task.sleep(nanoseconds: 30_000_000_000)
        }
      }
    } catch is CancellationError {
    } catch let e as NeedsConsent {
      if live(vault) { phase = .consent; done = 0; total = Int(e.bytes); message = nil }
    } catch {
      if live(vault) { phase = .error; message = "\(step): \(error.localizedDescription) Trying again in a minute." }
      // try again in a while (offline, server busy)
      try? await Task.sleep(nanoseconds: 60_000_000_000)
      if live(vault) { run = Task { await self.start(vault: vault, faces: faces) } }
    }
  }

  /** Adds the server's entries of a family since the cache's last visit. When the server has fewer than the cache,
   *  some were deleted there (MobileCLIP's go as the new ones are made): the cache starts over. anew: the cache now holds exactly the server's entries (it started from none). A server that doesn't count
   *  yet is taken at its word. */
  private func fetch(_ vault: Vault, _ cache: inout IndexCache, family: String) async throws -> (fresh: [String: String], anew: Bool) {
    if cache.since == 0 { cache.entries = [:] }
    var anew = cache.since == 0
    while true {
      var after = ""
      var fresh: [String: String] = [:]
      var pages = 0, got = 0
      var count: Int?
      while true {
        struct Page: Decodable { struct E: Decodable { let item_id: String; let data_enc: String; let updated_at: Int64 }; let entries: [E]; let next: String?; let count: Int? }
        let q = after.isEmpty ? "since=\(cache.since)" : "after=" + (after.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? after)
        let page = try await vault.api.get(Page.self, "/api/index?model=\(family)&\(q)")
        if after.isEmpty { count = page.count }
        for e in page.entries { cache.entries[e.item_id] = e.data_enc; fresh[e.item_id] = e.data_enc; cache.since = max(cache.since, e.updated_at) }
        pages += 1; got += page.entries.count
        guard let n = page.next, !n.isEmpty else { break }
        guard pages < Vault.maxListPages, got <= Vault.maxListItems, n != after else { throw APIError(status: -1, message: "The server's index list doesn't end.") }
        after = n
      }
      guard !anew, let count, cache.entries.count > count else { return (fresh, anew) }
      cache = IndexCache(); anew = true
    }
  }

  /** Fetches the server's entries for the active model since the cache's last visit and opens them into the index;
   *  all: the whole cache (at the start), otherwise only what is new. */
  private func pull(_ vault: Vault, _ cache: inout IndexCache, pair: KeyPair, faces: Bool, all: Bool) async throws {
    let (fresh, anew) = try await fetch(vault, &cache, family: clip.family)
    guard live(vault) else { throw CancellationError() } // locked meanwhile: nothing more is opened
    if !all && !anew && fresh.isEmpty { return }
    cache.write(vault, clip.family)
    let ids = Set(items.map(\.id))
    // entries deleted on the server meanwhile: out of the index, and made again by the device that indexes
    if anew { for id in tags.keys where cache.entries[id] == nil { tags.removeValue(forKey: id); index.remove(id); texts.removeValue(forKey: id); noText.remove(id) } }
    let entries = all || anew ? cache.entries : fresh
    let idx = index, clip = clip
    let opened = await Task.detached(priority: .utility) { () -> ([String: String], [String], [String: String], Set<String>) in
      var tags: [String: String] = [:]
      var bad: [String] = []
      var texts: [String: String] = [:]
      var noText = Set<String>()
      for (id, enc) in entries where ids.contains(id) {
        guard vault.isOpen, !Task.isCancelled else { break }
        guard let blob = try? B64.decode(enc), let e = try? IndexEntry.open(blob, pair: pair, itemId: id) else { bad.append(id); continue }
        let d = e.decoded(faces: faces)
        // a vector from the other model can't be compared with this one's: kept out until it is made again
        idx.put(id, clip: clip.owns(e.m) ? d.clip : nil, faces: d.faces)
        tags[id] = e.m
        let t = e.text
        if !t.isEmpty { texts[id] = t }
        if e.o == nil && clip.owns(e.m) { noText.insert(id) }
      }
      return (tags, bad, texts, noText)
    }.value
    guard live(vault) else { for id in opened.0.keys { idx.remove(id) }; throw CancellationError() } // opened during a lock: out again
    tags.merge(opened.0) { _, b in b }
    for id in opened.0.keys { texts[id] = opened.2[id]; if opened.3.contains(id) { noText.insert(id) } else { noText.remove(id) } }
    for id in opened.1 { cache.entries.removeValue(forKey: id) } // damaged or not for this item: made again
    for id in tags.keys where !ids.contains(id) { tags.removeValue(forKey: id); index.remove(id); texts.removeValue(forKey: id); noText.remove(id) }
    if anew { for id in noText where tags[id] == nil { noText.remove(id); texts.removeValue(forKey: id) } }
    version += 1
  }

  // ---- text in photos ----

  /** The text of an entry just made or read: kept for search, and whether it still needs reading. */
  private func noteText(_ id: String, _ e: IndexEntry) {
    let t = e.text
    texts[id] = t.isEmpty ? nil : t
    if e.o == nil && clip.owns(e.m) { noText.insert(id) } else { noText.remove(id) }
  }

  /** Opens the text model when the setting is on and its files are here; downloads them first when the person agreed
   *  to that. Never fails the run: without the OK it waits (ocrWaiting), offline it is tried again a minute later. */
  private func ensureOcr() async {
    guard indexes, settings.textInPhotos else { ocr = nil; ocrWaiting = false; return }
    guard ocr == nil else { return }
    let files = Models.ocrFiles, store = models
    ocrTriedAt = Date()
    if !(await Task.detached(priority: .utility) { store.have(files) }.value) {
      guard store.unagreed(files).isEmpty else { ocrWaiting = true; return }
      ocrWaiting = false
      do { try await store.download(files) { _ in } } catch is NeedsConsent { ocrWaiting = true; return } catch { return }
    }
    ocrWaiting = false
    let dir = store.dir
    let loaded = try? await Task.detached(priority: .utility) { try Ocr(dir: dir, threads: 2) }.value
    ocr = settings.textInPhotos && indexes ? loaded : nil // turned off meanwhile
  }

  /** The setting "Text in photos" changed (or another setting while the run goes on): off deletes the model's three
   *  files (and the yes to download them); on is picked up by the run. */
  private func textSettingChanged() {
    if !settings.textInPhotos {
      if ocr != nil || ocrWaiting || models.have(Models.ocrFiles) { models.removeOcr() }
      ocr = nil; ocrWaiting = false
    } else if ocr == nil {
      ocrTriedAt = .distantPast // the running loop loads it on its next idle round
    }
  }

  /** The question before the text model is downloaded; nil when nothing needs asking. */
  func ocrAsk() -> ModelConsentAsk? {
    let files = models.unagreed(Models.ocrFiles)
    guard !files.isEmpty else { return nil }
    return ModelConsentAsk(clip: clip, faces: false, reader: false, ocr: true, bytes: models.missingBytes(Models.ocrFiles))
  }

  /** Entries made before text in photos (no `o`): their text read and added, the image vector and faces kept, sealed
   *  again and stored under the same model tag. A few at a time, at the lowest priority; returns how many were done. */
  private func readTextAgain(_ vault: Vault, _ cache: inout IndexCache, ocr: Ocr, pair: KeyPair, pk: Data) async -> Int {
    let byId = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    guard !textFull else { return 0 }
    let todo = noText.subtracting(textSkipped).compactMap { byId[$0] }.sorted { $0.when > $1.when }.prefix(6)
    var n = 0
    for item in todo {
      guard live(vault), pending.isEmpty else { break } // new photos go first
      guard let enc = cache.entries[item.id], let blob = try? B64.decode(enc), var e = try? IndexEntry.open(blob, pair: pair, itemId: item.id),
            clip.owns(e.m) else { textSkipped.insert(item.id); continue }
      if e.o != nil { noteText(item.id, e); continue }
      do {
        let pic = try await vault.bestPicture(of: item)
        let text = try await Task.detached(priority: .background) { Ocr.normalize(try ocr.read(pic)) }.value
        guard live(vault) else { break }
        e.setText(text)
        let sealed = B64.encode(try e.seal(pk: pk, itemId: item.id))
        try await Self.put(sealed, model: e.m, item: item.id, api: vault.api)
        cache.entries[item.id] = sealed
        noteText(item.id, e)
        n += 1
      } catch let err as APIError where err.status == 0 || err.code == "not_indexer" {
        break // offline, or another device indexes now (the run notices): later
      } catch let err as APIError where err.status == 413 {
        // the account is full: entries with text are a little larger, so none fits now; not every photo is read only
        // to throw the text away
        textFull = true
        break
      } catch {
        textSkipped.insert(item.id)
      }
    }
    if n > 0 { version += 1 }
    return n
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

  /** What a setting would download that the person hasn't agreed to yet: the question to ask first, or nil when none
   *  is needed. reader: nil for this Mac's role now. */
  func consentAsk(_ clip: ClipModel, faces: Bool, reader: Bool? = nil) -> ModelConsentAsk? {
    let r = reader ?? !(AppModel.shared.me?.mayIndex ?? true)
    guard !models.unagreed(faces: faces, clip: clip, reader: r).isEmpty else { return nil }
    return ModelConsentAsk(clip: clip, faces: faces, reader: r, bytes: models.missingBytes(faces: faces, clip: clip, reader: r))
  }

  /** The question for what this run waits for (phase consent). */
  func pendingAsk() -> ModelConsentAsk {
    let faces = runFaces, reader = !indexes
    return ModelConsentAsk(clip: clip, faces: faces, reader: reader, bytes: models.missingBytes(faces: faces, clip: clip, reader: reader))
  }

  /** The yes; a run that waited for it goes on. */
  func agree(_ a: ModelConsentAsk) {
    if a.ocr {
      models.agree(Models.ocrFiles)
      ocrWaiting = false; ocrTriedAt = .distantPast // the run downloads it on its next idle round
      return
    }
    models.agree(faces: a.faces, clip: a.clip, reader: a.reader)
    if phase == .consent { restart() }
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
      // any entry of the model counts: whether the indexing device looks for faces is its own setting
      waiting = Models.waiting(items, tags: tags, faces: false, clip: clip)
      return
    }
    waiting = 0
    let queued = Set(pending.map(\.id)).union(inFlight).union(skipped)
    let todo = items.filter { Models.indexable($0) && !queued.contains($0.id) && !Models.good(tags[$0.id], faces: runFaces, clip: clip) }
    pending += todo
    total = items.filter { $0.kind != .other && !$0.broken }.count
    done = min(total, max(0, total - pending.count - inFlight.count))
  }

  /** Takes the app's current library when the one handed over is missing or out of date (another list or count), so a
   *  run never stays on an empty list; returns whether it changed. */
  @discardableResult private func adoptLibrary() -> Bool {
    let now = AppModel.shared.items
    guard AppModel.shared.vault === runVault, now.count != items.count || (now.first?.id != items.first?.id) else { return false }
    items = now
    return true
  }

  /** Starts the run again from the server's entries, for another model: entries made with the other one are made
   *  again (by whichever device gets to them first). */
  func restart() {
    guard let v = runVault else { return }
    let faces = runFaces
    // the library it was handed stays: stop(clear:) empties it, and the app hands it over again only when the library
    // changes, so a restart (this Mac taking over the indexing, another model) would index nothing
    let kept = items, keptSettings = settings
    stop(clear: true)
    items = kept; settings = keptSettings
    runVault = v; runFaces = faces
    run = Task { await self.start(vault: v, faces: faces) }
  }

  /** The person's choice of explicit search, saved in the people document for all their devices: search shows explicit
   *  photos too, or leaves them out. Nothing is indexed again or deleted. */
  func setExplicit(_ on: Bool) async throws {
    try await change { d in d.explicit = on ? true : nil }
    filtered = !Explicit.unfiltered(allowed: AppModel.shared.me?.user.nsfw == true, chosen: on)
    version += 1
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

  nonisolated static func indexFile(_ url: URL, id: String, video: Bool, faces: Bool, text: Bool, clip: ClipModel = .clip, pk: Data, api: API) async {
    let store = ModelStore(dir: Paths.models)
    guard store.have(faces: faces, clip: clip), let img = await Media.jpeg(url, video: video, maxPx: 2048, quality: 0.9),
          let v = try? Vision(dir: Paths.models, faces: faces, clip: clip, threads: 2) else { return }
    // the text in it too, when that is on and its model here (otherwise the indexing run reads it later)
    let ocr = text && store.have(Models.ocrFiles) ? try? Ocr(dir: Paths.models, threads: 2) : nil
    guard let a = try? v.analyze(img.data, faces: faces, clips: [clip], ocr: ocr) else { return }
    for entry in IndexEntry.entries(a, faces: faces) {
      guard let enc = try? entry.seal(pk: pk, itemId: id) else { return }
      try? await put(B64.encode(enc), model: entry.m, item: id, api: api)
    }
  }

  /** Stores a sealed entry with its model tag in the clear: the server takes only the current model's entries. A server from before that (1.7.4 and
   *  older) refuses the unknown field with 400 and gets the entry without it. */
  nonisolated static func put(_ enc: String, model: String, item: String, api: API) async throws {
    do {
      try await api.json("PUT", "/api/items/\(item)/index", body: ["data_enc": enc, "model": model])
    } catch let e as APIError where e.status == 400 {
      try await api.json("PUT", "/api/items/\(item)/index", body: ["data_enc": enc])
    }
  }

  // ---- queries ----

  /** items: what was found (the count says these); ranked: the image model ranked photos for the words, so the items
   *  are in its order, not by date; similar: the photos it ranks below its close matches, best first ("More similar
   *  photos", docs/SEARCH.md "Close matches"); chips: what the query was taken as (people, places, dates, favorites,
   *  videos, screenshots), each removable; found: for photos found by the text in them, the piece of it that matched */
  struct Result {
    var items: [Item]; var people: [Group]; var how: [String]; var ranked = false
    var similar: [Item] = []
    var chips: [QueryParser.Chip] = []
    var found: [String: String] = [:]
  }

  /** Every photo with an image vector from the model, best match first (search() keeps the close matches as results,
   *  CipherfilmCore/Matches.swift); the results page shows them a page at a time. Filtered (docs/SEARCH.md "Explicit content"): words close to
   *  explicit content find nothing, and photos that look explicit are left out. */
  func textHits(_ q: String) async -> [Hit] {
    guard ready, let vision else { return [] }
    if tokenizer == nil { tokenizer = try? Tokenizer(json: Models.verified(Models.tokenizer, in: models.dir)) } // the checked bytes
    guard let t = tokenizer else { return [] }
    let idx = index, filtered = filtered
    return await Task.detached(priority: .userInitiated) {
      guard let vec = try? vision.textVector(t.encode(q)) else { return [] }
      if filtered && Explicit.queryBlocked(vec) { return [] }
      return idx.search(vec, limit: Int.max, minScore: -2, filtered: filtered)
    }.value
  }

  func similar(to id: String) -> [String] { ready ? index.similar(id, limit: 60, minScore: 0.6).map(\.id) : [] }

  /** One search box for everything the Mac knows about a photo (docs/SEARCH.md "Combined search"): the query taken
   *  apart as on the web and the phone (QueryParser, the port of web/src/search/parse.ts); people, places, dates,
   *  favorites, videos and screenshots narrow (all of them); the words left find file names and cameras first, then
   *  photos taken at a place of that name, then photos with those words in them (text in photos), then what the
   *  photos show, ranked by the image model (in English: QueryParser's glossary). */
  func search(_ raw: String, library: [Item], favoritesOnly: Bool = false) async -> Result {
    let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return Result(items: [], people: [], how: []) }
    let base = library.filter { !$0.broken }
    // named people (hidden ones left out), in the order of their groups; a name may have several groups
    let gs = await peopleGroups()
    var names: [String] = []
    var byName: [String: Set<String>] = [:]
    for g in gs {
      guard let p = g.person, !p.name.isEmpty, p.hidden != true else { continue }
      if byName[p.name] == nil { names.append(p.name) }
      byName[p.name, default: []].formUnion(g.items)
    }
    // a word or two is a place only when photos were taken there
    let placed = await PlaceBook.names(base)
    let p = QueryParser.parse(q, .init(people: names, place: { $0.count >= 3 ? placed.names[$0] : nil }, today: QueryParser.localDay(Date().timeIntervalSince1970 * 1000)))
    let pool = base.filter { it in
      if p.favorites && !it.favorite { return false }
      if p.videos && it.kind != .video { return false }
      if p.screenshots && it.name.range(of: "screenshot|bildschirm", options: [.regularExpression, .caseInsensitive]) == nil { return false }
      for ns in p.people where !ns.contains(where: { byName[$0]?.contains(it.id) == true }) { return false }
      if !p.places.isEmpty {
        // by the folded name: two places spelled differently can fold alike ("Zürich", "Zurich")
        guard let here = placed.byItem[it.id]?.map(QueryParser.fold), p.places.allSatisfy({ here.contains(QueryParser.fold($0)) }) else { return false }
      }
      if !p.dates.isEmpty {
        let day = QueryParser.localDay(it.when)
        if !p.dates.allSatisfy({ QueryParser.inWhen($0, day) }) { return false }
      }
      return true
    }
    let wanted = Set(p.people.flatMap { $0 })
    let shown = gs.filter { g in g.person.map { wanted.contains($0.name) && $0.hidden != true } ?? false }
    guard !p.text.isEmpty else { return Result(items: pool.sorted { $0.when > $1.when }, people: shown, how: [], chips: p.chips) }

    var how: [String] = []
    let text = p.text
    let named = pool.filter { QueryParser.fold($0.name).contains(text) || QueryParser.fold("\($0.meta?.make ?? "") \($0.meta?.model ?? "")").contains(text) }
    let near = await PlaceBook.matching(text, in: pool)
    var found: [String: String] = [:]
    var read: [Item] = []
    for it in pool { if let m = QueryParser.textMatch(texts[it.id], text) { found[it.id] = m; read.append(it) } }
    let hits = p.clip.isEmpty ? [] : await textHits(p.clip)
    let inPool = Dictionary(pool.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var seen = Set<String>()
    var out: [Item] = []
    for i in named where seen.insert(i.id).inserted { out.append(i) }
    if !named.isEmpty { how.append("named “\(text)”") }
    for i in pool.filter({ near.contains($0.id) }).sorted(by: { $0.when > $1.when }) where seen.insert(i.id).inserted { out.append(i) }
    if !near.isEmpty { how.append("taken in “\(text)”") }
    for i in read where seen.insert(i.id).inserted { out.append(i) }
    if !read.isEmpty { how.append("“\(text)” in \(read.count == 1 ? "1 photo" : "\(read.count) photos")") }
    // what the image model ranks: the close matches among the photos the filters let through are results, the rest
    // similar photos (Matches, the same cut as the web and the phone)
    let ranked = hits.filter { inPool[$0.id] != nil && !seen.contains($0.id) }
    let close = Matches.close(ranked.map(\.score))
    for h in ranked.prefix(close) { if let it = inPool[h.id], seen.insert(it.id).inserted { out.append(it) } }
    let similar = ranked.dropFirst(close).compactMap { inPool[$0.id] }
    if close > 0 { how.append("showing “\(p.clip)”") }
    return Result(items: out, people: shown, how: how, ranked: !ranked.isEmpty, similar: similar, chips: p.chips, found: found)
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
      // the cover is a face in a photo the list has (never one of an item it wasn't handed, such as a locked one)
      let cover = g.cover.flatMap { live.contains($0.item) ? $0 : nil }
        ?? its.lazy.flatMap { id in self.index.facesOf(id).filter { g.faces.contains($0.key) }.map { FaceGroup.Cover(key: $0.key, item: id, box: $0.box) } }.first
      if let p = person { guard seen.insert(p.id).inserted else { return nil } }
      return Group(key: person?.id ?? "g\(i):\(g.cover?.key ?? "")", person: person, items: its, faces: g.faces, cover: cover)
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

  static let families = [ClipModel.clip.family, ClipModel.legacyFamily]
  static func url(_ v: Vault, _ family: String) -> URL? { v.cacheDir?.appendingPathComponent("index-\(family).json") }
  static func read(_ v: Vault, _ family: String) -> IndexCache {
    // before 1.9.0 one file held either model's entries; it is fetched again per model
    if let old = v.cacheDir?.appendingPathComponent("index.json") { try? FileManager.default.removeItem(at: old) }
    return url(v, family).flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(IndexCache.self, from: $0) } ?? IndexCache()
  }
  func write(_ v: Vault, _ family: String) {
    guard let u = Self.url(v, family) else { return }
    try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let d = try? JSONEncoder().encode(self), (try? d.write(to: u, options: .atomic)) != nil { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: u.path) }
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

/** What the question before a model download is about (ModelConsentSheet). */
struct ModelConsentAsk: Identifiable, Equatable {
  let clip: ClipModel
  let faces: Bool
  let reader: Bool
  /** the text model alone (text in photos), asked for on its own: a no never holds up the other models */
  var ocr = false
  let bytes: Int64
  var id: String { ocr ? "ocr" : "\(clip.rawValue)-\(faces)-\(reader)" }

  /** Which models, in words, by what they are for (files and sizes come from the model list, whichever model). */
  var what: String {
    if ocr { return "the model that reads text in photos" }
    return Models.needed(faces: faces, clip: clip, reader: reader).contains { $0.faces } ? "the search model and the face models" : "the search model"
  }
}
