import Foundation

// How the question before the map names who serves it (as web/src/places/mapHosts.ts does): "OpenFreeMap" only for
// the server's exact default (server/mapconf.go defaultMap), otherwise every host of the light and dark styles and
// their fallbacks, so a dark style on another host is never left out.
extension Me.MapStyles {
  public static let defaultLight = ["https://tiles.openfreemap.org/styles/positron", "https://tiles.versatiles.org/assets/styles/muted/style.json"]
  public static let defaultDark = ["https://tiles.openfreemap.org/styles/dark", "https://tiles.versatiles.org/assets/styles/colorful-dark/style.json"]

  public var isDefault: Bool { light == Self.defaultLight && dark == Self.defaultDark }

  /** Every host the map may load from, in order, once each ("maps.example.org", "other.example.net:8443"). */
  public var hosts: [String] {
    var out: [String] = []
    for s in light + dark {
      guard let u = URLComponents(string: s), let h = u.host?.lowercased(), !h.isEmpty else { continue }
      let host = h + (u.port.map { ":\($0)" } ?? "")
      if !out.contains(host) { out.append(host) }
    }
    return out
  }

  /** "OpenFreeMap" for the default, else the hosts joined with ", ". */
  public var provider: String { isDefault ? "OpenFreeMap" : hosts.joined(separator: ", ") }
}
