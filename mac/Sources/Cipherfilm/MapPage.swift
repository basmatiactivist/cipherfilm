// The map (docs/MAP.md): photos as clustered round thumbnails on a base map, and a photo's spot in its details.
// MapLibre GL JS runs in a web view of its own, served from the app bundle (Contents/Resources/map, copied there by
// scripts/map-assets.sh) under cfmap://app/, never from the network. Coordinates and thumbnails are decrypted on this
// Mac and handed only to that page; the base map's server (the styles the Cipherfilm server names, OpenFreeMap by
// default) sees which tiles are loaded and nothing else: the map opens on the whole world and never moves to the
// photos by itself, its data store lives in memory (no cookies), and no referrer is sent.
import AppKit
import CipherfilmCore
import SwiftUI
import WebKit

/** Place names from the GeoNames file in the app bundle (Places.swift), loaded the first time one is needed. */
enum PlaceBook {
  static let places: Places? = Bundle.main.url(forResource: "places-v1", withExtension: "bin").flatMap { try? Places(contentsOf: $0) }

  /** "Zürich, Switzerland" for coordinates; nil far out at sea or without the file. Looked up off the main thread. */
  static func label(_ g: GPS) async -> String? {
    await Task.detached(priority: .userInitiated) { places?.nearest(g.lat, g.lon)?.label }.value
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var words: [String: [String]] = [:]

  /** The located items whose place (town, region, country, country code; with and without accents) starts with every
   *  word typed, as web/src/library.tsx finds them. Each item's place words are worked out once, the first time
   *  something is searched. */
  static func matching(_ query: String, in items: [Item]) async -> Set<String> {
    let q = Places.fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
    guard !q.isEmpty, q.allSatisfy({ $0.count >= 2 }) else { return [] }
    let located = items.compactMap { it in it.location.map { (it.id, $0) } }
    return await Task.detached(priority: .userInitiated) {
      guard let p = places else { return Set<String>() }
      var out = Set<String>()
      for (id, g) in located {
        let w: [String] = lock.withLock { words[id] } ?? {
          let w = p.nearest(g.lat, g.lon).map { Places.fold($0.words).split(separator: " ").map(String.init) } ?? []
          lock.withLock { words[id] = w }
          return w
        }()
        if !w.isEmpty, q.allSatisfy({ qw in w.contains { $0.hasPrefix(qw) } }) { out.insert(id) }
      }
      return out
    }.value
  }

  /** Signing out or locking: nothing about where photos were taken stays in memory. */
  static func forget() { lock.withLock { words = [:] } }
}

/** One photo on the map, as the page gets it. */
struct MapPoint: Encodable { let id: String; let lat: Double; let lon: Double; let ts: Double }

/** The map's page in a web view, and the messages between it and the app. */
@MainActor @Observable
final class MapController: NSObject, WKNavigationDelegate, WKUIDelegate {
  enum Mode { case map, mini(GPS) }
  let mode: Mode
  let styles: Me.MapStyles
  @ObservationIgnored private(set) var web: WKWebView!
  @ObservationIgnored private weak var model: AppModel?
  /** the page loaded its base map style */
  private(set) var styleLoaded = false
  /** no style of the list could be loaded */
  private(set) var failed = false
  /** markers drawn at the moment */
  private(set) var markers = 0
  @ObservationIgnored var onPhotos: (([String]) -> Void)?
  @ObservationIgnored var onOpen: ((String) -> Void)?
  @ObservationIgnored private var points: [MapPoint] = []
  @ObservationIgnored private var dark: Bool
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var center: GPS?
  @ObservationIgnored private var thumbs: [String: String] = [:]

  init(mode: Mode, styles: Me.MapStyles, dark: Bool, model: AppModel) {
    self.mode = mode; self.styles = styles; self.dark = dark; self.model = model
    if case .mini(let g) = mode { center = g }
    super.init()
    let conf = WKWebViewConfiguration()
    // nothing kept: no cookies, no cache on disk, nothing of the page outlives it
    conf.websiteDataStore = .nonPersistent()
    conf.setURLSchemeHandler(MapAssets(styles: styles, mini: isMini), forURLScheme: MapAssets.scheme)
    conf.userContentController.addScriptMessageHandler(Relay(self), contentWorld: .page, name: "cf")
    conf.preferences.isElementFullscreenEnabled = false
    conf.preferences.javaScriptCanOpenWindowsAutomatically = false
    let w = isMini ? StillWebView(frame: .zero, configuration: conf) : WKWebView(frame: .zero, configuration: conf)
    w.navigationDelegate = self
    w.uiDelegate = self
    w.allowsMagnification = false
    w.allowsBackForwardNavigationGestures = false
    #if DEBUG
    if #available(macOS 13.3, *) { w.isInspectable = true }
    // the test driver runs while the screen may be off: WebKit would stop drawing a page it thinks nobody sees
    let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if ProcessInfo.processInfo.environment["CF_AUTOTEST"] == "1", w.responds(to: occlusion) { w.setValue(false, forKey: "windowOcclusionDetectionEnabled") }
    #endif
    web = w
    w.load(URLRequest(url: URL(string: "\(MapAssets.scheme)://app/map.html")!))
  }

  /** The view is gone: the page stops and lets go of the app (its callbacks hold the view's state). */
  func close() {
    onPhotos = nil; onOpen = nil
    web.stopLoading()
    web.configuration.userContentController.removeAllScriptMessageHandlers()
    web.loadHTMLString("", baseURL: nil)
  }

  private var isMini: Bool { if case .mini = mode { return true }; return false }

  /** The located photos to show (map tab). */
  func show(_ items: [Item]) {
    let p = items.compactMap { it in it.location.map { MapPoint(id: it.id, lat: $0.lat, lon: $0.lon, ts: it.when) } }
    guard p.map(\.id) != points.map(\.id) else { return }
    points = p
    if ready { call("cf.setPoints(\(json(p)))") }
  }

  func setDark(_ d: Bool) {
    guard d != dark else { return }
    dark = d
    if ready { styleLoaded = false; call("cf.setDark(\(d))") }
  }

  /** The small map moves to another photo's spot. */
  func move(to g: GPS) {
    guard center != g else { return }
    center = g
    if ready { call("cf.center(\(g.lat), \(g.lon))") }
  }

  /** The ids of the photos inside what the map shows now. */
  func inView() async -> [String] {
    guard ready else { return [] }
    return ((try? await web.callAsyncJavaScript("return cf.inView()", contentWorld: .page)) as? [String]) ?? []
  }

  private func call(_ js: String) { web.evaluateJavaScript(js, in: nil, in: .page) { _ in } }

  private func json<T: Encodable>(_ v: T) -> String { (try? JSONEncoder().encode(v)).flatMap { String(data: $0, encoding: .utf8) } ?? "null" }

  /** The page's messages; some want an answer. */
  func message(_ body: Any) async -> Any? {
    guard let m = body as? [String: Any], let t = m["t"] as? String else { return nil }
    switch t {
    case "config":
      ready = true
      var c: [String: Any] = ["mode": isMini ? "mini" : "map", "dark": dark, "styles": ["light": styles.light, "dark": styles.dark]]
      if let g = center { c["lat"] = g.lat; c["lon"] = g.lon }
      if !isMini { c["points"] = points.map { ["id": $0.id, "lat": $0.lat, "lon": $0.lon, "ts": $0.ts] as [String: Any] } }
      return c
    case "styleLoaded": styleLoaded = true; failed = false
    case "failed": failed = true
    case "markers": markers = m["n"] as? Int ?? 0
    case "thumb":
      guard let id = m["id"] as? String else { return nil }
      return await thumb(id)
    case "photos": if let ids = m["ids"] as? [String] { onPhotos?(ids) }
    case "open": if let id = m["id"] as? String { onOpen?(id) }
    case "log":
      #if DEBUG
      print("map page: \(m["s"] as? String ?? "")"); fflush(stdout)
      #endif
    default: break
    }
    return nil
  }

  /** A small JPEG of the item's thumbnail for a marker, from the same decrypted thumbnails the grid shows. */
  private func thumb(_ id: String) async -> String? {
    if let hit = thumbs[id] { return hit }
    guard let model, let it = model.item(id), let v = model.vault else { return nil }
    var img = model.images.cachedThumb(id)
    if img == nil { img = await model.images.thumb(it, v) }
    guard let img, let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let url = await Task.detached(priority: .userInitiated) { MapController.dataURL(cg) }.value
    if let url {
      if thumbs.count > 600 { thumbs.removeAll() }
      thumbs[id] = url
    }
    return url
  }

  /** At most 120 px on the short side (a 52 pt marker on a Retina screen), as a JPEG data URL. */
  nonisolated static func dataURL(_ cg: CGImage, px: Int = 120) -> String? {
    let s = min(1, Double(px) / Double(max(1, min(cg.width, cg.height))))
    let w = max(1, Int(Double(cg.width) * s)), h = max(1, Int(Double(cg.height) * s))
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let small = ctx.makeImage(), let jpg = NSBitmapImageRep(cgImage: small).representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return nil }
    return "data:image/jpeg;base64," + jpg.base64EncodedString()
  }

  // ---- navigation: the page stays the page; links (the map's attribution) open in the browser ----

  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let u = a.request.url else { return .cancel }
    if u.scheme == MapAssets.scheme { return .allow }
    if a.navigationType == .linkActivated, u.scheme == "https" { NSWorkspace.shared.open(u) }
    return .cancel
  }

  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url, u.scheme == "https" { NSWorkspace.shared.open(u) }
    return nil
  }

  /** The page's process quit (memory pressure): load it again. */
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    ready = false; styleLoaded = false
    w.load(URLRequest(url: URL(string: "\(MapAssets.scheme)://app/map.html")!))
  }
}

/** The script message handler holds its controller weakly (the web view's configuration would keep it alive). */
@MainActor
private final class Relay: NSObject, WKScriptMessageHandlerWithReply {
  weak var to: MapController?
  init(_ to: MapController) { self.to = to }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    // only the page's own frame, only from the app's scheme
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == MapAssets.scheme, let to else { replyHandler(nil, nil); return }
    let body = message.body
    Task { @MainActor in replyHandler(await to.message(body), nil) }
  }
}

/** The small map in a photo's details: the scroll wheel scrolls the details, not the map. */
private final class StillWebView: WKWebView {
  override func scrollWheel(with e: NSEvent) { nextResponder?.scrollWheel(with: e) }
}

/** Serves the map's page, MapLibre and its stylesheet from the app bundle: cfmap://app/<file>, those files only. */
@MainActor
final class MapAssets: NSObject, WKURLSchemeHandler {
  static let scheme = "cfmap"
  static let files: [String: String] = [
    "map.html": "text/html", "map.js": "text/javascript", "map.css": "text/css",
    "maplibre-gl.mjs": "text/javascript", "maplibre-gl-worker.mjs": "text/javascript", "maplibre-gl.css": "text/css",
  ]
  let csp: String
  let mini: Bool

  init(styles: Me.MapStyles, mini: Bool) {
    // the base map's hosts only; MapLibre's worker runs from a blob of its own bytes (map.js) and so has this policy too
    let hosts = styles.origins.joined(separator: " "), scheme = Self.scheme
    csp = "default-src 'none'; script-src \(scheme):; style-src \(scheme):; img-src \(scheme): blob: data:; font-src \(scheme):; "
      + "connect-src \(scheme): \(hosts); worker-src blob:; child-src blob:; base-uri 'none'; form-action 'none'"
    self.mini = mini
  }

  static func folder() -> URL? { Bundle.main.resourceURL?.appendingPathComponent("map", isDirectory: true) }

  func webView(_ w: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url, url.host == "app", let mime = Self.files[url.lastPathComponent], url.path == "/" + url.lastPathComponent,
          let dir = Self.folder(), var data = try? Data(contentsOf: dir.appendingPathComponent(url.lastPathComponent)) else {
      task.didFailWithError(URLError(.fileDoesNotExist)); return
    }
    if url.lastPathComponent == "map.html" {
      let page = String(decoding: data, as: UTF8.self)
        .replacingOccurrences(of: "__CSP__", with: csp)
        .replacingOccurrences(of: "__MODE__", with: mini ? "mini" : "map")
        .replacingOccurrences(of: "__LABEL__", with: mini ? "Where this photo was taken" : "Map of your photos")
      data = Data(page.utf8)
    }
    let headers = ["Content-Type": mime + "; charset=utf-8", "Content-Length": "\(data.count)", "Content-Security-Policy": csp,
                   "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ w: WKWebView, stop task: any WKURLSchemeTask) {}
}

struct MapWebView: NSViewRepresentable {
  let controller: MapController
  func makeNSView(context: Context) -> WKWebView { controller.web }
  func updateNSView(_ v: WKWebView, context: Context) {}
}

// ---- the map tab ----

/** The map tab: until the person turns the map on (Settings, or here), a short consent screen and no web view, so
 *  no map image is requested before they agreed. */
struct MapTab: View {
  @Environment(AppModel.self) private var model
  @Bindable var selection: Selection

  var body: some View {
    if model.settings.mapOn {
      MapScreen(selection: selection)
    } else {
      MapConsent(styles: model.me?.map) { model.settings.mapOn = true }
    }
  }
}

struct MapConsent: View {
  let styles: Me.MapStyles?
  let turnOn: () -> Void
  static let privacy = URL(string: "https://cipherfilm.app/privacy#map")!

  /** "OpenFreeMap" for the default styles, else the host the server's style comes from. */
  static func provider(_ styles: Me.MapStyles?) -> String {
    let host = styles?.light.first.flatMap { URLComponents(string: $0)?.host } ?? ""
    return host == "tiles.openfreemap.org" || host.isEmpty ? "OpenFreeMap" : host
  }

  var body: some View {
    let p = Self.provider(styles)
    let from = p == "OpenFreeMap" ? "from OpenFreeMap" : "from the map server set on your Cipherfilm server (\(p))"
    VStack(spacing: 0) {
      PageTitle(title: "Map")
      Spacer()
      VStack(alignment: .leading, spacing: 14) {
        Image(systemName: "map").font(.system(size: 30)).foregroundStyle(Ink.teal)
        Text("Show your photos on a map?").font(Typo.dialog).foregroundStyle(Ink.ink)
        Text("The map images come \(from). It sees this Mac's IP address and which areas you look at, never your photos or where they were taken: those stay encrypted and are drawn on this Mac.")
          .font(Typo.body).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 16) {
          Button("Turn on map", action: turnOn).buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
          Button("Privacy policy") { NSWorkspace.shared.open(Self.privacy) }.buttonStyle(TextLink())
        }
        .padding(.top, 4)
      }
      .padding(28)
      .frame(maxWidth: 480, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
      .padding(.horizontal, 28)
      Spacer()
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct MapScreen: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  @Environment(\.colorScheme) private var scheme
  @Bindable var selection: Selection
  @State private var map: MapController?
  @State private var panel: Panel?

  struct Panel: Equatable { var title: String; var ids: [String] }

  var body: some View {
    let located = model.items.filter { $0.location != nil }
    VStack(spacing: 0) {
      HStack(alignment: .bottom) {
        PageTitle(title: "Map", subtitle: located.isEmpty ? "No photos with a location yet" : located.count == 1 ? "1 photo on the map" : "\(located.count) photos on the map")
        if !located.isEmpty {
          Button { Task { await inView() } } label: { Label("Photos in This Area", systemImage: "photo.on.rectangle") }
            .buttonStyle(SecondaryButton()).padding(.trailing, 28).padding(.bottom, 8)
            .help("List the photos inside what the map shows")
        }
      }
      HStack(spacing: 16) {
        ZStack(alignment: .top) {
          if let map {
            MapWebView(controller: map)
              .clipShape(RoundedRectangle(cornerRadius: Radius.card))
              .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
            if map.failed {
              Note(text: "The map couldn't be loaded. Check the connection and try again later.").padding(12).frame(maxWidth: 460)
            }
          } else {
            RoundedRectangle(cornerRadius: Radius.card).fill(Ink.paperDeep)
          }
        }
        if let panel {
          MapPanel(panel: panel, selection: selection) { self.panel = nil }
            .frame(width: 340)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      .padding(.horizontal, 28).padding(.bottom, 20).padding(.top, 6)
    }
    .animation(.easeOut(duration: Motion.fast), value: panel)
    .onAppear {
      guard map == nil, let styles = model.me?.map else { return }
      let c = MapController(mode: .map, styles: styles, dark: scheme == .dark, model: model)
      c.onPhotos = { ids in show(ids, title: nil) }
      c.onOpen = { id in nav.viewer = ViewerState(ids: [id], index: 0) }
      c.show(model.items)
      map = c
      #if DEBUG
      DebugHooks.shared.map = c
      #endif
    }
    .onDisappear { map?.close(); map = nil }
    .onChange(of: model.items) { map?.show(model.items) }
    .onChange(of: scheme) { _, s in map?.setDark(s == .dark) }
  }

  private func inView() async {
    guard let map else { return }
    show(await map.inView(), title: "This area")
  }

  /** The panel's photos, newest first; its title is the place of the newest one. */
  private func show(_ ids: [String], title: String?) {
    let items = ids.compactMap { model.item($0) }.sorted { $0.when > $1.when }
    let fallback = title ?? (items.count == 1 ? "1 photo" : "\(items.count) photos")
    panel = Panel(title: fallback, ids: items.map(\.id))
    guard title == nil, let g = items.first?.location else { return }
    Task {
      if let name = await PlaceBook.label(g), panel?.ids == items.map(\.id) { panel?.title = name }
    }
  }
}

/** The photos of a cluster, or of the area shown, beside the map; a click opens them in the viewer. */
struct MapPanel: View {
  @Environment(AppModel.self) private var model
  @Environment(Navigator.self) private var nav
  let panel: MapScreen.Panel
  @Bindable var selection: Selection
  let close: () -> Void

  var body: some View {
    let items = panel.ids.compactMap { model.item($0) }
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 2) {
          Text(panel.title).font(Typo.heading).foregroundStyle(Ink.ink).lineLimit(1).truncationMode(.tail)
          Text(items.count == 1 ? "1 photo" : "\(items.count) photos").font(Typo.small).foregroundStyle(Ink.muted)
        }
        Spacer()
        Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Close").accessibilityLabel("Close")
      }
      .padding(14)
      Divider()
      if items.isEmpty {
        Text("No photos in this area.").font(Typo.body).foregroundStyle(Ink.muted).padding(14)
        Spacer()
      } else {
        PhotoGrid(items: items, grouping: .none, selection: selection, inset: 12) { it, list in
          nav.viewer = ViewerState(ids: list.map(\.id), index: list.firstIndex(of: it) ?? 0)
        }
        .padding(.top, 10)
      }
    }
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Ink.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Ink.rule, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: Radius.card))
  }
}

// ---- the small map in a photo's details ----

struct MiniMap: View {
  @Environment(AppModel.self) private var model
  @Environment(\.colorScheme) private var scheme
  let at: GPS
  let styles: Me.MapStyles
  @State private var map: MapController?

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: Radius.control).fill(Ink.paperDeep)
      if let map { MapWebView(controller: map) }
    }
    .frame(height: 170)
    .clipShape(RoundedRectangle(cornerRadius: Radius.control))
    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Ink.rule, lineWidth: 1))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Map of where this photo was taken")
    .onAppear {
      guard map == nil else { return }
      let c = MapController(mode: .mini(at), styles: styles, dark: scheme == .dark, model: model)
      map = c
      #if DEBUG
      DebugHooks.shared.mini = c
      #endif
    }
    .onDisappear { map?.close(); map = nil }
    .onChange(of: at) { _, g in map?.move(to: g) }
    .onChange(of: scheme) { _, s in map?.setDark(s == .dark) }
  }
}
